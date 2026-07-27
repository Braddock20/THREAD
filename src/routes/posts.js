// src/routes/posts.js — POST/GET/GET-by-id/PATCH/DELETE + nested replies (depth 3)
// Auth: none. We trust the caller (separate backend handles auth).
import prisma from "../lib/prisma.js";
import { getSignedDownloadUrl, absolutizeLocalUrl } from "../lib/storage.js";

const MAX_DEPTH = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Recursively load replies up to MAX_DEPTH. Uses a single recursive CTE so
 * we don't N+1 across the thread tree. Excludes the root post id.
 */
async function loadReplies(rootId, depth) {
  if (depth <= 0) return [];
  // Recursive CTE: walk parentId chain down from rootId, depth-first by createdAt ASC.
  const rows = await prisma.$queryRawUnsafe(
    `
    WITH RECURSIVE thread AS (
      SELECT id, "parentId", content, tags, "createdAt", "updatedAt", 1 AS depth
      FROM "Post"
      WHERE "parentId" = $1
      UNION ALL
      SELECT p.id, p."parentId", p.content, p.tags, p."createdAt", p."updatedAt", t.depth + 1
      FROM "Post" p
      JOIN thread t ON p."parentId" = t.id
      WHERE t.depth < $2
    )
    SELECT id, "parentId", content, tags, "createdAt", "updatedAt", depth
    FROM thread
    ORDER BY depth ASC, "createdAt" ASC;
    `,
    rootId,
    depth
  );

  if (rows.length === 0) return [];

  // Fetch all media for these posts in one query
  const ids = rows.map((r) => r.id);
  const mediaRows = await prisma.media.findMany({
    where: { postId: { in: ids } },
    orderBy: { createdAt: "asc" },
  });
  const mediaByPost = new Map();
  for (const m of mediaRows) {
    if (!mediaByPost.has(m.postId)) mediaByPost.set(m.postId, []);
    mediaByPost.get(m.postId).push(m);
  }

  // Hydrate signed URLs (per request)
  const hydrated = await Promise.all(
    rows.map(async (r) => {
      const media = (mediaByPost.get(r.id) || []).map((m) => ({
        id: m.id,
        type: m.type,
        url: absolutizeLocalUrl(req, m.url),
        filename: m.filename,
        mime_type: m.mimeType,
        size: m.size,
        created_at: m.createdAt,
      }));
      return {
        id: r.id,
        content: r.content,
        parent_id: r.parentId,
        tags: r.tags,
        depth: r.depth,
        media,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    })
  );

  // Nest into tree
  const byId = new Map(hydrated.map((n) => [n.id, { ...n, replies: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function serializePost(p, opts = {}) {
  return {
    id: p.id,
    content: p.content,
    parent_id: p.parentId,
    tags: p.tags,
    media: (p.media || []).map((m) => ({
      id: m.id,
      type: m.type,
      url: absolutizeLocalUrl(opts.req, m.url),
      filename: m.filename,
      mime_type: m.mimeType,
      size: m.size,
      created_at: m.createdAt,
    })),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export default async function postRoutes(app) {
  // POST /posts — create post (optional parentId, tags[])
  app.post("/", async (req, reply) => {
    const body = req.body || {};
    const content = typeof body.content === "string" ? body.content.trim() : null;
    const parentId = body.parentId || null;
    const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean).slice(0, 10) : [];
    const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds : [];

    if (!content && mediaIds.length === 0) {
      return reply.code(400).send({ error: "empty_post", message: "content or media required" });
    }
    if (parentId) {
      const parent = await prisma.post.findUnique({ where: { id: parentId } });
      if (!parent) return reply.code(404).send({ error: "parent_not_found" });
    }

    // Attach existing media rows (created via /media/upload beforehand) to this post
    const media = mediaIds.length
      ? await prisma.media.findMany({ where: { id: { in: mediaIds } } })
      : [];

    const post = await prisma.post.create({
      data: {
        content,
        parentId,
        tags,
        media: media.length
          ? { connect: media.map((m) => ({ id: m.id })) }
          : undefined,
      },
      include: { media: true },
    });

    return reply.code(201).send({ post: serializePost(post, { req }) });
  });

  // GET /posts — paginated timeline, newest first, ?cursor=&limit=
  app.get("/", async (req) => {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
    const cursor = req.query.cursor || null;
    // Only top-level posts (parentId IS NULL) on the main timeline.
    const where = { parentId: null };
    const posts = await prisma.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { media: true },
    });
    const hasMore = posts.length > limit;
    const slice = hasMore ? posts.slice(0, limit) : posts;
    return {
      posts: slice.map((p) => serializePost(p, { req })),
      next_cursor: hasMore ? slice[slice.length - 1].id : null,
    };
  });

  // GET /posts/:id — single post with nested replies (depth 3)
  app.get("/:id", async (req, reply) => {
    const { id } = req.params;
    const post = await prisma.post.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!post) return reply.code(404).send({ error: "not_found" });

    const replies = await loadReplies(id, MAX_DEPTH - 1); // root is depth 1, replies up to depth 3
    return {
      post: { ...serializePost(post, { req }), replies },
    };
  });

  // PATCH /posts/:id — edit content/tags
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params;
    const body = req.body || {};
    const data = {};
    if (typeof body.content === "string") data.content = body.content.trim() || null;
    if (Array.isArray(body.tags)) data.tags = body.tags.map(String).filter(Boolean).slice(0, 10);

    const post = await prisma.post.update({
      where: { id },
      data,
      include: { media: true },
    });
    return { post: serializePost(post, { req }) };
  });

  // DELETE /posts/:id — cascades and deletes attached media
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params;
    const post = await prisma.post.findUnique({
      where: { id },
      include: { media: true, replies: { select: { id: true } } },
    });
    if (!post) return reply.code(404).send({ error: "not_found" });
    if (post.replies.length > 0) {
      return reply.code(409).send({
        error: "has_replies",
        message: "delete or move replies before deleting this post",
        reply_ids: post.replies.map((r) => r.id),
      });
    }
    // Delete storage objects (best-effort, don't fail the request if R2/B2 errors)
    await Promise.all(
      post.media.map(async (m) => {
        try {
          const { deleteObject } = await import("../lib/storage.js");
          // url is "/local-blob/<key>?..." in local mode or a full URL in B2 mode.
          // We store keys separately on the Media row? No — Media.url is the public/signed URL.
          // For local mode we extract the key from the URL; for B2 we skip (orphaned file is acceptable).
          if (m.url.startsWith("/local-blob/")) {
            const u = new URL(m.url, "http://x");
            await deleteObject(decodeURIComponent(u.pathname.replace("/local-blob/", "")));
          }
        } catch (err) {
          req.log.warn({ err: err?.message, mediaId: m.id }, "media delete failed (orphaned)");
        }
      })
    );
    await prisma.post.delete({ where: { id } });
    return reply.code(204).send();
  });
}