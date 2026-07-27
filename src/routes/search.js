// src/routes/search.js — search + tag-scoped feed.
// Mounted under /posts prefix in server.js so paths become:
//   GET /posts/search?q=&tag=&type=
//   GET /posts/tags/:tag
import prisma from "../lib/prisma.js";
import { absolutizeLocalUrl } from "../lib/storage.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function serialize(p, req) {
  return {
    id: p.id,
    content: p.content,
    parent_id: p.parentId,
    tags: p.tags,
    media: (p.media || []).map((m) => ({
      id: m.id,
      type: m.type,
      url: absolutizeLocalUrl(req, m.url),
      filename: m.filename,
      mime_type: m.mimeType,
      size: m.size,
      created_at: m.createdAt,
    })),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export default async function searchRoutes(app) {
  // GET /posts/search?q=&tag=&type=&limit=
  app.get("/search", async (req, reply) => {
    const q = (req.query.q || "").toString().trim();
    const tag = req.query.tag ? String(req.query.tag).toLowerCase().trim() : null;
    const mediaType = req.query.type ? String(req.query.type) : null;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));

    if (!q && !tag && !mediaType) {
      return reply.code(400).send({
        error: "missing_query",
        message: "supply at least one of q, tag, type",
      });
    }

    const where = {};
    if (q) {
      // Postgres case-insensitive contains
      where.content = { contains: q, mode: "insensitive" };
    }
    if (tag) {
      // Postgres array contains: tag must be present in tags[]
      where.tags = { has: tag };
    }
    if (mediaType) {
      where.media = { some: { type: mediaType } };
    }

    const posts = await prisma.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { media: true },
    });

    return {
      query: { q, tag, type: mediaType, limit },
      count: posts.length,
      posts: posts.map((p) => serialize(p, req)),
    };
  });

  // GET /posts/tags/:tag — feed of posts with that tag
  app.get("/tags/:tag", async (req) => {
    const tag = String(req.params.tag).toLowerCase().trim();
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
    const posts = await prisma.post.findMany({
      where: { tags: { has: tag } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { media: true },
    });
    return {
      tag,
      count: posts.length,
      posts: posts.map((p) => serialize(p, req)),
    };
  });
}