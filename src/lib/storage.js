// src/lib/storage.js — Backblaze B2 (S3-compatible) or local filesystem driver.
// Switch via STORAGE_DRIVER env: "b2" (default) or "local" (dev).
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import cfg from "../config.js";

let _s3 = null;

function b2Client() {
  if (_s3) return _s3;
  if (!cfg.B2.KEY_ID || !cfg.B2.APPLICATION_KEY) {
    throw new Error(
      "B2 credentials not configured. Set B2_KEY_ID + B2_APPLICATION_KEY " +
      "— or STORAGE_DRIVER=local for dev."
    );
  }
  _s3 = new S3Client({
    region: cfg.B2.REGION,
    endpoint: cfg.B2.ENDPOINT,
    credentials: {
      accessKeyId: cfg.B2.KEY_ID,
      secretAccessKey: cfg.B2.APPLICATION_KEY,
    },
    forcePathStyle: false, // B2 supports virtual-hosted-style
  });
  return _s3;
}

// ---------------- Local filesystem driver (dev only) ----------------

function localPath(key) {
  const root = resolve(cfg.LOCAL_STORAGE_DIR);
  const target = resolve(root, key);
  if (!target.startsWith(root + "/") && target !== root) {
    throw new Error("invalid_key_path");
  }
  return target;
}

async function ensureLocalDir(key) {
  await mkdir(dirname(localPath(key)), { recursive: true });
}

function localSign(key, expiresIn) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = createHmac("sha256", "local-storage-dev-secret")
    .update(`${key}|${exp}`)
    .digest("hex")
    .slice(0, 32);
  return { sig, exp };
}

// ---------------- Public API ----------------

export async function uploadBuffer(key, buffer, contentType) {
  if (cfg.STORAGE_DRIVER === "local") {
    await ensureLocalDir(key);
    await writeFile(localPath(key), buffer);
    return key;
  }
  await b2Client().send(
    new PutObjectCommand({
      Bucket: cfg.B2.BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );
  return key;
}

export async function getSignedDownloadUrl(key, expiresIn = cfg.SIGNED_URL_EXPIRES) {
  if (cfg.STORAGE_DRIVER === "local") {
    const { sig, exp } = localSign(key, expiresIn);
    return `/local-blob/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }
  const command = new GetObjectCommand({ Bucket: cfg.B2.BUCKET, Key: key });
  return getSignedUrl(b2Client(), command, { expiresIn });
}

export async function deleteObject(key) {
  if (cfg.STORAGE_DRIVER === "local") {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(localPath(key));
    } catch { /* ignore */ }
    return;
  }
  await b2Client().send(new DeleteObjectCommand({ Bucket: cfg.B2.BUCKET, Key: key }));
}

export async function readLocalSigned(key, exp, sig) {
  if (cfg.STORAGE_DRIVER !== "local") throw new Error("local driver not active");
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) throw new Error("url_expired");
  const expected = createHmac("sha256", "local-storage-dev-secret")
    .update(`${key}|${exp}`)
    .digest("hex")
    .slice(0, 32);
  if (expected !== sig) throw new Error("bad_signature");
  return readFile(localPath(key));
}

// Returns a public-ish URL: if local driver, caller should absolutize via req host.
// If B2, this is already a fully-signed absolute URL.
export function absolutizeLocalUrl(req, relativeUrl) {
  if (!relativeUrl.startsWith("/")) return relativeUrl;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers.host;
  return `${proto}://${host}${relativeUrl}`;
}