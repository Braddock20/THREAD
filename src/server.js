// src/server.js — Fastify bootstrap for Glass Journal.
// Auth: none (handled by a separate backend).
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import cfg from "./config.js";
import postRoutes from "./routes/posts.js";
import mediaRoutes from "./routes/media.js";
import searchRoutes from "./routes/search.js";
import prisma from "./lib/prisma.js";
import { readLocalSigned } from "./lib/storage.js";

const app = Fastify({
  logger: {
    level: cfg.NODE_ENV === "production" ? "info" : "debug",
    transport: cfg.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
  // Explicit bodyLimit for video / APK uploads. Default Fastify is 1MB.
  // Multipart adds ~10-20% overhead, so add a small safety margin.
  bodyLimit: Math.ceil(cfg.MAX_UPLOAD_BYTES * 1.1),
  trustProxy: true, // Render + reverse proxies
});

async function start() {
  await app.register(sensible);

  // Baseline global rate-limit (200 req/min per IP).
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    cache: 10_000,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    keyGenerator: (req) => req.ip,
  });

  // Multipart with the same upload ceiling (in bytes).
  await app.register(multipart, {
    limits: {
      fileSize: cfg.MAX_UPLOAD_BYTES,
      files: 10, // allow up to 10 attachments per upload
    },
  });

  await app.register(postRoutes, { prefix: "/posts" });
  await app.register(mediaRoutes, { prefix: "/media" });
  await app.register(searchRoutes, { prefix: "/posts" });

  // Health check (Render)
  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // Local-driver signed-URL endpoint (only mounted in local mode).
  if (cfg.STORAGE_DRIVER === "local") {
    app.get("/local-blob/:key", async (req, reply) => {
      const key = decodeURIComponent(req.params.key);
      const { exp, sig } = req.query;
      try {
        const buf = await readLocalSigned(key, exp, sig);
        reply.header("Content-Type", "application/octet-stream");
        return reply.send(buf);
      } catch (err) {
        return reply.code(403).send({ error: err.message || "forbidden" });
      }
    });
  }

  // Stricter upload rate-limit: 60/hour per IP (videos are big, don't spam).
  app.addHook("onRoute", (route) => {
    if (route.method === "POST" && route.url.endsWith("/upload")) {
      route.config = { ...route.config, rateLimit: { max: 60, timeWindow: "1 hour" } };
    }
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", path: req.url })
  );
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  // Boot-time DB ping
  if (cfg.DATABASE_URL) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      app.log.info("db connection ok");
    } catch (err) {
      app.log.warn({ err: err?.message }, "db connection failed at boot (continuing)");
    }
  } else {
    app.log.warn("DATABASE_URL missing — DB endpoints will fail until configured");
  }

  app.listen({ port: cfg.PORT, host: "0.0.0.0" }, (err, addr) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(
      `glass-journal listening on ${addr} (env=${cfg.NODE_ENV}, ` +
      `storage=${cfg.STORAGE_DRIVER}, max_upload=${Math.round(cfg.MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`
    );
  });
}

start().catch((err) => {
  console.error("fatal boot error:", err);
  process.exit(1);
});

const shutdown = async (sig) => {
  app.log.info(`received ${sig}, shutting down…`);
  try { await app.close(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));