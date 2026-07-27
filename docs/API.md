# Glass Journal — API Documentation

Single-user, private, X/Threads-style personal feed.
Auth is handled by a separate backend — this service trusts every request.
All responses are JSON unless noted. Errors return `{ "error": "<code>", "detail"?: "<msg>", ... }`.

Base URL on Render: `https://glass-journal-api.onrender.com`
Local dev: `http://localhost:3000`

---

## Table of Contents

- [Health](#health)
- [Posts](#posts)
  - [POST /posts](#post-posts)
  - [GET /posts](#get-posts)
  - [GET /posts/:id](#get-postsid)
  - [PATCH /posts/:id](#patch-postsid)
  - [DELETE /posts/:id](#delete-postsid)
- [Search](#search)
  - [GET /posts/search](#get-postssearch)
  - [GET /posts/tags/:tag](#get-poststagstag)
- [Media](#media)
  - [POST /media/upload](#post-mediaupload)
  - [GET /media/allowed-mimes](#get-mediaallowed-mimes)
- [Data Model](#data-model)
- [Error Codes](#error-codes)
- [Rate Limits](#rate-limits)
- [Examples](#examples)

---

## Health

### `GET /health`

Liveness probe used by Render.

```bash
curl http://localhost:3000/health
```

**Response 200**
```json
{
  "ok": true,
  "ts": "2026-07-05T14:00:00.000Z"
}
```

---

## Posts

### POST /posts

Create a post. Threading via `parentId`. Attach existing media via `mediaIds` (uploaded previously via `POST /media/upload`).

```bash
curl -X POST http://localhost:3000/posts \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello world",
    "parentId": null,
    "tags": ["intro", "first-post"],
    "mediaIds": ["clx123abc...", "clx456def..."]
  }'
```

**Body fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string \| null | no* | Post text. Trimmed. |
| `parentId` | string \| null | no | ID of parent post if this is a reply. |
| `tags` | string[] | no | Up to 10 tags. Lowercased on the server side via filter. |
| `mediaIds` | string[] | no | IDs of `Media` rows to attach. |

*At least one of `content` or `mediaIds` must be present.

**Response 201**
```json
{
  "post": {
    "id": "cm5x8p...",
    "content": "Hello world",
    "parent_id": null,
    "tags": ["intro", "first-post"],
    "media": [
      {
        "id": "clx123abc...",
        "type": "image",
        "url": "https://s3.us-west-004.backblazeb2.com/...",
        "filename": "sunset.png",
        "mime_type": "image/png",
        "size": 238401,
        "created_at": "2026-07-05T14:00:00.000Z"
      }
    ],
    "created_at": "2026-07-05T14:00:00.000Z",
    "updated_at": "2026-07-05T14:00:00.000Z"
  }
}
```

**Errors**

| Status | Code | Cause |
|---|---|---|
| 400 | `empty_post` | both `content` and `mediaIds` are empty |
| 404 | `parent_not_found` | `parentId` doesn't match any post |

---

### GET /posts

Paginated timeline, **top-level posts only** (parentId is null), newest first.

```bash
curl "http://localhost:3000/posts?limit=20&cursor=cm5x8p..."
```

**Query parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | 20 | 1–100 |
| `cursor` | string | none | Last `id` from the previous page |

**Response 200**
```json
{
  "posts": [ { "id": "...", "content": "...", "media": [...], ... } ],
  "next_cursor": "cm5x9q..." | null
}
```

`next_cursor` is `null` when you've reached the end.

---

### GET /posts/:id

Single post with **nested replies up to depth 3** (root → replies → nested replies → nested nested replies).

```bash
curl http://localhost:3000/posts/cm5x8p
```

**Response 200**
```json
{
  "post": {
    "id": "cm5x8p...",
    "content": "This is the root",
    "parent_id": null,
    "tags": ["intro"],
    "media": [],
    "created_at": "...",
    "updated_at": "...",
    "replies": [
      {
        "id": "cm5x9a...",
        "content": "Reply depth 2",
        "parent_id": "cm5x8p...",
        "tags": ["reply"],
        "depth": 2,
        "media": [],
        "created_at": "...",
        "updated_at": "...",
        "replies": [
          {
            "id": "cm5x9b...",
            "content": "Nested reply depth 3",
            "parent_id": "cm5x9a...",
            "depth": 3,
            "media": [],
            "replies": [],
            ...
          }
        ]
      }
    ]
  }
}
```

**Depth limit:** 3 levels (root + 2 reply levels). Replies beyond depth 3 are not returned. Adjust `MAX_DEPTH` in `src/routes/posts.js` to change.

**Errors**

| Status | Code | Cause |
|---|---|---|
| 404 | `not_found` | No post with this id |

---

### PATCH /posts/:id

Edit `content` and/or `tags`. Media is **not** editable — delete and re-attach if you need to swap.

```bash
curl -X PATCH http://localhost:3000/posts/cm5x8p \
  -H "Content-Type: application/json" \
  -d '{ "content": "Updated text", "tags": ["edited"] }'
```

**Body fields (any combination)**

| Field | Type | Description |
|---|---|---|
| `content` | string \| null | New content. Pass empty string to clear. |
| `tags` | string[] | Replaces tags entirely. Up to 10. |

**Response 200** — full updated post object.

---

### DELETE /posts/:id

Deletes the post. **Cascades** to attached `Media` rows and removes the underlying B2 objects (best-effort — orphaned files are tolerated).

Returns **409** if the post has replies, so you don't accidentally strand children.

```bash
curl -X DELETE http://localhost:3000/posts/cm5x8p
```

**Response**

| Status | Body |
|---|---|
| 204 | *(empty)* |
| 404 | `{ "error": "not_found" }` |
| 409 | `{ "error": "has_replies", "reply_ids": [...], "message": "..." }` |

---

## Search

### GET /posts/search

Combined filter — `q`, `tag`, `type` are AND-ed. At least one is required.

```bash
curl "http://localhost:3000/posts/search?q=hello&tag=intro&type=image&limit=20"
```

**Query parameters**

| Param | Type | Description |
|---|---|---|
| `q` | string | Case-insensitive substring match against `content` |
| `tag` | string | Must be present in `tags[]` (exact, lowercase) |
| `type` | string | Filter posts that have at least one media of this `type` — one of: `image`, `video`, `audio`, `voice_note`, `apk`, `file` |
| `limit` | int | 1–100 (default 20) |

**Response 200**
```json
{
  "query": { "q": "hello", "tag": "intro", "type": "image", "limit": 20 },
  "count": 3,
  "posts": [ ... ]
}
```

**Errors**

| Status | Code | Cause |
|---|---|---|
| 400 | `missing_query` | all three of `q`/`tag`/`type` are empty |

---

### GET /posts/tags/:tag

Feed of posts tagged with `:tag` (case-insensitive lookup normalized server-side).

```bash
curl http://localhost:3000/posts/tags/intro
```

**Response 200**
```json
{
  "tag": "intro",
  "count": 5,
  "posts": [ ... ]
}
```

---

## Media

### POST /media/upload

Upload a file to B2. Returns a `Media` row. **Two-step pattern** for posts with attachments:
1. `POST /posts` to create the post → get `post.id`
2. `POST /media/upload` with `post_id=<id>` for each file → get `media.id`
3. *Or:* upload first as orphan, attach later by passing `mediaIds[]` to `POST /posts`

```bash
curl -X POST http://localhost:3000/media/upload \
  -F "post_id=cm5x8p..." \
  -F "file=@./sunset.png"
```

**Multipart fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | binary | yes | The file (PNG, JPG, MP4, MP3, WAV, APK, ZIP, PDF, etc.) |
| `post_id` | string | no | Attach to existing post on upload. |

**Allowed mime types (24 total):**
- **image/** — jpeg, png, gif, webp, svg+xml
- **video/** — mp4, quicktime, webm, x-matroska, x-msvideo
- **audio/** — mpeg, mp4, webm, ogg, wav, x-wav, aac, flac, x-m4a
- **apk** — `application/vnd.android.package-archive`, `application/java-archive`
- **file** — `application/pdf`, `application/zip`, `application/x-zip-compressed`

A `voice_note` is any `audio/*` blob whose filename contains `voice`, `voicenote`, `voice-note`, or `recording`.

**Response 201**
```json
{
  "media": {
    "id": "clx123abc...",
    "post_id": "cm5x8p..." | null,
    "type": "image" | "video" | "audio" | "voice_note" | "apk" | "file",
    "url": "https://s3.us-west-004.backblazeb2.com/...",
    "filename": "sunset.png",
    "mime_type": "image/png",
    "size": 238401,
    "created_at": "..."
  }
}
```

**Errors**

| Status | Code | Cause |
|---|---|---|
| 400 | `expected_multipart` | not a multipart request |
| 400 | `missing_file` | no file part |
| 400 | `unsupported_media` | mime not in allow-list |
| 400 | `post_id_required` | (legacy; nullable now — only triggered if postId is explicitly empty string) |
| 404 | `post_not_found` | `post_id` doesn't exist |
| 413 | `file_too_large` | exceeds `MAX_UPLOAD_BYTES` (default 500 MB) |
| 502 | `storage_upload_failed` | B2 rejected the upload |

**Max upload size:** configured via `MAX_UPLOAD_BYTES` env (default `524288000` = 500 MB). Per-request hard limit enforced both at the Fastify `bodyLimit` level and at the multipart `fileSize` level.

---

### GET /media/allowed-mimes

Returns the allowed mime list — handy for client UIs to validate before uploading.

```bash
curl http://localhost:3000/media/allowed-mimes
```

**Response 200**
```json
{
  "mimes": [
    "image/jpeg",
    "image/png",
    "...",
    "application/vnd.android.package-archive"
  ]
}
```

---

## Data Model

```
Post
  id          string  (cuid)
  content     string?
  parentId    string?
  parent      Post?   (self-relation PostThread)
  replies     Post[]  (self-relation PostThread)
  tags        string[]
  media       Media[]
  createdAt   DateTime
  updatedAt   DateTime

Media
  id          string  (cuid)
  postId      string? (nullable — orphan media)
  post        Post?
  type        string  (image | video | audio | voice_note | apk | file)
  url         string  (signed URL, expires per SIGNED_URL_EXPIRES)
  filename    string
  mimeType    string
  size        int
  createdAt   DateTime
```

**On delete:**
- `DELETE /posts/:id` → cascade deletes attached `Media` rows + best-effort delete from B2
- `DELETE /posts/:id` with replies → 409, no data is touched

**Depth:** threads are returned with up to **3 levels** total (root + 2 reply levels). Adjust `MAX_DEPTH` in `src/routes/posts.js` to change.

---

## Error Codes

Standard envelope: `{ "error": "<machine-readable-code>", "detail"?: "<human msg>" }`.

| Code | When |
|---|---|
| `not_found` | Missing post / route 404 |
| `empty_post` | POST /posts with no content and no media |
| `parent_not_found` | parentId doesn't exist |
| `has_replies` | DELETE on a post with children |
| `unsupported_media` | mime not allowed |
| `missing_file` | multipart without a file part |
| `expected_multipart` | POST is not multipart |
| `file_too_large` | over `MAX_UPLOAD_BYTES` |
| `missing_query` | /posts/search without q/tag/type |
| `storage_upload_failed` | B2 error |
| `media_persist_failed` | DB error after upload succeeded (storage object cleaned up) |
| `internal_error` | catch-all |

---

## Rate Limits

| Scope | Limit | Window |
|---|---|---|
| Global baseline | 200 req | 1 minute (per IP) |
| `POST /media/upload` | 60 req | 1 hour (per IP) |

Tune in `src/server.js` via Fastify route config. `X-RateLimit-*` headers surface on every response.

---

## Examples

### Create a post with an image attachment

```bash
# Step 1: create the post
POST /posts
{ "content": "Look at this", "tags": ["photo"] }
→ { "post": { "id": "POSTID", "media": [], ... } }

# Step 2: upload the image, attaching it
POST /media/upload
   -F "post_id=POSTID"
   -F "file=@./photo.jpg"
→ { "media": { "id": "MEDIAID", "type": "image", "url": "https://...", ... } }
```

### Reply to a post

```bash
POST /posts
{ "content": "I agree", "parentId": "POSTID" }
→ 201 with the reply post
```

### Browse a tag feed

```bash
GET /posts/tags/photo
→ { "tag": "photo", "count": 7, "posts": [...] }
```

### Search posts by media type

```bash
GET /posts/search?type=video&q=sunset
→ { "query": { "q": "sunset", "type": "video" }, "count": 3, "posts": [...] }
```

### Paginate a long timeline

```bash
GET /posts?limit=20
→ { "posts": [...], "next_cursor": "cm5x..." }

GET /posts?limit=20&cursor=cm5x...
→ next page
```

---

*Spec frozen at v1. Changes to the depth limit, allowed mimes, or schema are tracked in CHANGELOG.md (TBD).*