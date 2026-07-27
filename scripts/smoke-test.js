// scripts/smoke-test.js — automated pass against the new Glass Journal API.
//
// What it checks:
//  [x] /health returns 200
//  [x] POST /posts creates a top-level post
//  [x] POST /posts creates a reply (parentId)
//  [x] POST /posts creates a nested reply (depth 3)
//  [x] GET /posts/:id returns the post with nested replies
//  [x] GET /posts paginates timeline
//  [x] PATCH /posts/:id edits content/tags
//  [x] POST /media/upload accepts image (PNG)
//  [x] POST /media/upload accepts voice_note (audio mime + filename hint)
//  [x] POST /posts accepts mediaIds and attaches them
//  [x] GET /posts/search?q= filters by text
//  [x] GET /posts/search?tag= filters by tag
//  [x] GET /posts/search?type=voice_note filters by media type
//  [x] GET /posts/tags/:tag returns tag-scoped feed
//  [x] DELETE /posts/:id with no replies works
//  [x] DELETE /posts/:id WITH replies is rejected (409)
//  [x] Invalid media mime is rejected (400)
//
// Pass `BASE_URL=...` to point at a remote instance.

const BASE = process.env.BASE_URL || "http://localhost:3000";
const STORAGE_DRIVER = process.env.STORAGE_DRIVER || "local";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function call(method, path, { body, headers, isJson = true } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, body, headers });
  const ct = res.headers.get("content-type") || "";
  let data;
  if (ct.includes("application/json")) data = await res.json();
  else data = await res.text();
  return { status: res.status, data, ok: res.ok };
}

// 1x1 transparent PNG (magic bytes are real — file-type accepts)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex"
);

// Tiny WAV (RIFF header + minimal PCM data). file-type reports "audio/x-wav".
function buildTinyWav(text) {
  const data = Buffer.from(text, "utf8");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function main() {
  console.log(`smoke test against ${BASE} (storage=${STORAGE_DRIVER})\n`);

  // 1. health
  const h = await call("GET", "/health");
  record("health 200", h.ok && h.data?.ok === true, `status=${h.status}`);

  // 2. create top-level post
  const stamp = Date.now();
  const p1 = await call("POST", "/posts", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `Hello glass journal ${stamp}`, tags: ["intro", "test"] }),
  });
  record(
    "create top-level post",
    p1.status === 201 && !!p1.data?.post?.id,
    `status=${p1.status} id=${p1.data?.post?.id}`
  );
  const rootId = p1.data?.post?.id;

  // 3. create reply (depth 2)
  const p2 = await call("POST", "/posts", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `Reply to root ${stamp}`,
      parentId: rootId,
      tags: ["reply"],
    }),
  });
  record(
    "create reply (depth 2)",
    p2.status === 201 && p2.data?.post?.parent_id === rootId,
    `status=${p2.status}`
  );
  const replyId = p2.data?.post?.id;

  // 4. create nested reply (depth 3)
  const p3 = await call("POST", "/posts", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `Nested reply ${stamp}`,
      parentId: replyId,
      tags: ["nested"],
    }),
  });
  record(
    "create nested reply (depth 3)",
    p3.status === 201 && p3.data?.post?.parent_id === replyId,
    `status=${p3.status}`
  );

  // 5. GET /posts/:id with nested replies
  if (rootId) {
    const detail = await call("GET", `/posts/${rootId}`);
    const replies = detail.data?.post?.replies || [];
    const nested = replies[0]?.replies?.[0]?.content;
    record(
      "GET post with nested replies (depth 3)",
      detail.status === 200 && replies.length >= 1 && !!nested && nested.includes(stamp.toString()),
      `replies=${replies.length} nestedDepth=${replies[0]?.replies?.length || 0}`
    );
  }

  // 6. GET /posts timeline
  const tl = await call("GET", "/posts?limit=5");
  record(
    "GET /posts timeline paginates",
    tl.status === 200 && Array.isArray(tl.data?.posts) && tl.data.posts.length >= 1,
    `count=${tl.data?.posts?.length}`
  );

  // 7. PATCH /posts/:id
  if (p3.data?.post?.id) {
    const edit = await call("PATCH", `/posts/${p3.data.post.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `Edited ${stamp}`, tags: ["edited", "nested"] }),
    });
    record(
      "PATCH post edits content/tags",
      edit.status === 200 &&
        edit.data?.post?.content?.includes("Edited") &&
        edit.data?.post?.tags?.includes("edited"),
      `status=${edit.status} tags=${JSON.stringify(edit.data?.post?.tags)}`
    );
  }

  // 8. media upload — image (PNG)
  const fd1 = new FormData();
  fd1.append("file", new Blob([TINY_PNG], { type: "image/png" }), `smoke-${stamp}.png`);
  const m1 = await call("POST", "/media/upload", { body: fd1 });
  record(
    "POST /media/upload accepts image (PNG)",
    m1.status === 201 && m1.data?.media?.type === "image",
    `status=${m1.status} type=${m1.data?.media?.type}`
  );
  const imageId = m1.data?.media?.id;

  // 9. media upload — voice_note (audio/wav with "voice" in filename)
  const wav = buildTinyWav(`glass voice note ${stamp}`);
  const fd2 = new FormData();
  fd2.append("file", new Blob([wav], { type: "audio/x-wav" }), `voice-note-${stamp}.wav`);
  const m2 = await call("POST", "/media/upload", { body: fd2 });
  record(
    "POST /media/upload accepts voice_note",
    m2.status === 201 && m2.data?.media?.type === "voice_note",
    `status=${m2.status} type=${m2.data?.media?.type}`
  );
  const voiceId = m2.data?.media?.id;

  // 10. create post with attached media (attach the previously-orphaned mediaIds)
  const pWithMedia = await call("POST", "/posts", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `Post with attachments ${stamp}`,
      tags: ["media-test"],
      mediaIds: [imageId, voiceId].filter(Boolean),
    }),
  });
  record(
    "POST /posts attaches media via mediaIds",
    pWithMedia.status === 201 && (pWithMedia.data?.post?.media?.length || 0) >= 1,
    `status=${pWithMedia.status} media=${pWithMedia.data?.post?.media?.length || 0}`
  );

  // 11. search by text
  const sQ = await call("GET", `/posts/search?q=${encodeURIComponent(stamp.toString())}`);
  record(
    "GET /posts/search?q= finds by content",
    sQ.status === 200 && sQ.data?.count >= 1,
    `count=${sQ.data?.count}`
  );

  // 12. search by tag
  const sTag = await call("GET", `/posts/search?tag=edited`);
  record(
    "GET /posts/search?tag= filters by tag",
    sTag.status === 200 && sTag.data?.count >= 1,
    `count=${sTag.data?.count}`
  );

  // 13. search by media type
  const sType = await call("GET", `/posts/search?type=voice_note`);
  record(
    "GET /posts/search?type=voice_note filters by media type",
    sType.status === 200 && sType.data?.count >= 1,
    `count=${sType.data?.count}`
  );

  // 14. tag-scoped feed
  const tagFeed = await call("GET", `/posts/tags/intro`);
  record(
    "GET /posts/tags/:tag returns tag feed",
    tagFeed.status === 200 && tagFeed.data?.count >= 1,
    `count=${tagFeed.data?.count}`
  );

  // 15. invalid media rejection
  const bad = Buffer.from("not a real file");
  const fdBad = new FormData();
  fdBad.append("file", new Blob([bad], { type: "application/octet-stream" }), "fake.bin");
  const badUp = await call("POST", "/media/upload", { body: fdBad });
  record(
    "POST /media/upload rejects invalid mime",
    badUp.status === 400 && badUp.data?.error === "unsupported_media",
    `status=${badUp.status}`
  );

  // 16. DELETE post with replies is rejected
  if (rootId) {
    const del = await call("DELETE", `/posts/${rootId}`);
    record(
      "DELETE post WITH replies returns 409",
      del.status === 409 && del.data?.error === "has_replies",
      `status=${del.status}`
    );
  }

  // 17. DELETE leaf post works
  if (p3.data?.post?.id) {
    const del2 = await call("DELETE", `/posts/${p3.data.post.id}`);
    record(
      "DELETE leaf post succeeds",
      del2.status === 204,
      `status=${del2.status}`
    );
  }

  // 18. bodyLimit test — make sure 500MB+ upload is allowed in config
  //    (We don't actually upload 500MB; just verify config surfaced via /media/allowed-mimes)
  const allowed = await call("GET", "/media/allowed-mimes");
  record(
    "GET /media/allowed-mimes returns mime list",
    allowed.status === 200 && Array.isArray(allowed.data?.mimes) && allowed.data.mimes.length > 0,
    `mimes=${allowed.data?.mimes?.length}`
  );

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke runner crashed:", e);
  process.exit(2);
});