# Glass Journal — Backend

Fastify + Prisma + Postgres (Neon) + Backblaze B2. Single-user, private, X/Threads-style personal feed.

Auth is handled by a separate backend — this service has none.

---

## Endpoints

```
GET  /health
POST /posts                         — create post { content?, parentId?, tags?, mediaIds? }
GET  /posts?cursor=&limit=          — paginated timeline (top-level only, newest first)
GET  /posts/:id                     — single post + nested replies (depth 3)
PATCH /posts/:id                    — edit content / tags
DELETE /posts/:id                   — cascades media; rejected (409) if replies exist
GET  /posts/search?q=&tag=&type=    — combined filters
GET  /posts/tags/:tag               — tag-scoped feed
POST /media/upload                  — multipart, attaches to post_id (or orphan)
GET  /media/allowed-mimes           — for client UI hints
```

Media types accepted: `image`, `video`, `audio`, `voice_note` (audio + "voice" in filename), `apk`, generic `file` (pdf/zip).

---

## Local dev

```bash
cp .env.example .env       # fill in DATABASE_URL at minimum
npm install
npx prisma migrate dev     # creates tables
npm run dev                # http://localhost:3000
curl http://localhost:3000/health
```

For local testing without B2, set `STORAGE_DRIVER=local` in `.env` — uploads go to `./local-storage/` and are served via a tiny signed-URL endpoint.

```bash
DATABASE_URL=postgresql://... STORAGE_DRIVER=local npm run smoke
```

---

## Environment Variables

| Var | Required | Source |
|---|---|---|
| `DATABASE_URL` | yes | neon.tech → New Project → connection string |
| `B2_KEY_ID` | yes (prod) | Backblaze B2 → App Keys |
| `B2_APPLICATION_KEY` | yes (prod) | same |
| `B2_BUCKET_NAME` | yes (prod) | B2 bucket name (create `glass-journal` first) |
| `B2_ENDPOINT` | yes (prod) | `https://s3.us-west-004.backblazeb2.com` (match your bucket's region) |
| `B2_REGION` | yes (prod) | e.g. `us-west-004` |
| `PORT` | no | default `3000` |
| `NODE_ENV` | no | `production` on Render |
| `MAX_UPLOAD_BYTES` | no | default `524288000` (500 MB) |
| `SIGNED_URL_EXPIRES` | no | default `3600` (1 hour; B2 max is 7 days) |
| `STORAGE_DRIVER` | no | `b2` (default) or `local` |
| `LOCAL_STORAGE_DIR` | no | default `./local-storage` |

---

## Deploy to Render

1. Push to GitHub.
2. Render → New → Web Service → connect repo → auto-detects `render.yaml`.
3. Open **Environment** tab, paste the B2 + Neon secrets from the table above.
4. Click **Manual Deploy → Deploy latest commit**.
5. Health check hits `/health`. First deploy runs `prisma migrate deploy` automatically.

---

## Pre-deploy checklist

- [ ] `npm install` clean
- [ ] Prisma migration runs against Neon
- [ ] `npm run smoke` passes locally with `STORAGE_DRIVER=local`
- [ ] Upload a small PNG via `POST /media/upload` → returns media id
- [ ] Create a post with `mediaIds: [...]` → media appears in `GET /posts/:id`
- [ ] Search by tag returns expected posts
- [ ] DELETE with replies returns 409 (don't accidentally orphan threads)
- [ ] `GET /health` returns 200

---

## What's deferred

- Auth — handled by a separate backend
- Threading beyond depth 3 — adjust `MAX_DEPTH` in `src/routes/posts.js`
- Image resizing / video transcoding — uploads store originals
- Full-text search ranking — uses simple Postgres `ILIKE` for v1; add `tsvector` later if needed