// scripts/migrate-to-new-db.js
//
// Copies Post + Media rows from the OLD (shared) database into the NEW
// (dedicated) database, rewriting Media URLs to the permanent
// /media/blob/:key format along the way.
//
// READ-ONLY on the old database — only findMany() is used against it.
// Nothing there is ever modified, dropped, or deleted. The other
// project's tables (Department, Faculty, etc.) are never even
// referenced, so they're untouched.
//
// Run via the GitHub Actions workflow (migrate-db.yml) — not meant to
// be run manually unless you know what OLD_DATABASE_URL / NEW_DATABASE_URL
// / PUBLIC_BASE_URL are set to.

import { PrismaClient } from "@prisma/client";

const OLD_URL = process.env.OLD_DATABASE_URL;
const NEW_URL = process.env.NEW_DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!OLD_URL || !NEW_URL || !PUBLIC_BASE_URL) {
  console.error("Missing OLD_DATABASE_URL, NEW_DATABASE_URL, or PUBLIC_BASE_URL.");
  process.exit(1);
}

const oldDb = new PrismaClient({ datasources: { db: { url: OLD_URL } } });
const newDb = new PrismaClient({ datasources: { db: { url: NEW_URL } } });

// Recovers the raw storage key from an old stored URL (handles both the
// B2 signed-URL format and the local-driver /local-blob format).
function extractKey(url) {
  if (!url) return null;
  if (url.includes("/local-blob/")) {
    const after = url.split("/local-blob/")[1];
    return after ? decodeURIComponent(after.split("?")[0]) : null;
  }
  if (url.startsWith("http")) {
    try {
      const { pathname } = new URL(url);
      return decodeURIComponent(pathname.replace(/^\//, ""));
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  console.log("Reading from OLD database (read-only)...");
  const posts = await oldDb.post.findMany({ orderBy: { createdAt: "asc" } });
  const media = await oldDb.media.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`Found ${posts.length} post(s), ${media.length} media row(s).`);

  console.log("Writing posts to NEW database...");
  for (const p of posts) {
    const { id, ...rest } = p;
    await newDb.post.create({ data: { id, ...rest } });
  }

  console.log("Writing media to NEW database with permanent URLs...");
  let fixed = 0;
  let skipped = 0;
  for (const m of media) {
    const key = m.key || extractKey(m.url);
    if (!key) {
      console.warn(`  skip: could not determine key for media ${m.id} (url: ${m.url})`);
      skipped++;
      continue;
    }
    const url = `${PUBLIC_BASE_URL}/media/blob/${encodeURIComponent(key)}`;
    const { id, ...rest } = m;
    await newDb.media.create({
      data: { id, ...rest, key, url },
    });
    fixed++;
  }

  console.log(`Done. Migrated ${posts.length} post(s), ${fixed} media row(s) (${skipped} skipped).`);
  await oldDb.$disconnect();
  await newDb.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await oldDb.$disconnect();
  await newDb.$disconnect();
  process.exit(1);
});
