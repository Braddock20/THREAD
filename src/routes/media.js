// src/routes/media.js — POST /media/upload
// Uploads a file to B2 (or local driver), records a Media row.
// Media URLs are now permanent — they point at our own /media/blob/:key
// route, which mints a fresh signed B2 URL and redirects on every request.
import { v4 as uuidv4 } from "uuid";
import prisma from "../lib/prisma.js";
import cfg from "../config.js";
import { uploadBuffer, getSignedDownloadUrl, absolutizeLocalUrl, deleteObject } from "../lib/storage.js";
import { detectMediaType, finalizeMediaType, sanitizeFilenameForKey, ALLOWED_MIMES } from "../lib/media.js";

export default async function mediaRoutes(app) {
  app.get("/allowed-mimes", async () => ({ mimes: ALLOWED_MIMES }));

  // Permanent link: mints a fresh signed URL and redirects, every request.
  app.get("/blob/:key", async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    let target = await getSignedDownloadUrl(key, 300); // fresh 5-min token
    if (target.startsWith("/")) target = absolutizeLocalUrl(req, target);
    return reply.redirect(302, target);
  });

  app.post("/upload", async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "expected_multipart" });
    }

    let buf = null;
    let filename = null;
    let postId = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        const chunks = [];
        for await (const c of part.file) chunks.push(c);
        buf = Buffer.concat(chunks);
        filename = part.filename;
      } else if (part.type === "field" && part.fieldname === "post_id") {
        postId = String(part.value);
      }
    }

    if (!buf) return reply.code(400).send({ error: "missing_file" });
    if (buf.length > cfg.MAX_UPLOAD_BYTES) {
      return reply.code(413).send({
        error: "file_too_large",
        size: buf.length,
        max: cfg.MAX_UPLOAD_BYTES,
      });
    }

    const detection = await detectMediaType(buf);
    if (!detection.ok) {
      return reply.code(400).send({
        error: "unsupported_media",
        reason: detection.reason,
        allowed: ALLOWED_MIMES,
      });
    }

    if (postId) {
      const exists = await prisma.post.findUnique({ where: { id: postId } });
      if (!exists) return reply.code(404).send({ error: "post_not_found" });
    }

    const mediaType = finalizeMediaType(detection.kind, filename, buf.length);

    const key = `media/${uuidv4()}/${sanitizeFilenameForKey(filename || "file")}`;
    try {
      await uploadBuffer(key, buf, detection.mime);
    } catch (err) {
      req.log.error({ err: err?.message }, "storage upload failed");
      return reply.code(502).send({ error: "storage_upload_failed", detail: err.message });
    }

    // PERMANENT URL — points at our own server, which mints a fresh
    // signed B2 URL on every request. Never expires from the client's side.
    const url = absolutizeLocalUrl(req, `/media/blob/${encodeURIComponent(key)}`);

    let media;
    try {
      media = await prisma.media.create({
        data: {
          postId: postId || null,
          type: mediaType,
          url,
          key,
          filename: filename || "file",
          mimeType: detection.mime,
          size: buf.length,
        },
      });
    } catch (err) {
      try { await deleteObject(key); } catch {}
      req.log.error({ err: err?.message }, "media row insert failed");
      return reply.code(500).send({ error: "media_persist_failed", detail: err.message });
    }

    return reply.code(201).send({
      media: {
        id: media.id,
        post_id: media.postId,
        type: media.type,
        url: media.url,
        filename: media.filename,
        mime_type: media.mimeType,
        size: media.size,
        created_at: media.createdAt,
      },
    });
  });
}
