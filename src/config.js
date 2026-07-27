// src/config.js — central config + global guards.
// Auth: none — handled by a separate backend. This service trusts every request.
import "dotenv/config";

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const MAX_UPLOAD_BYTES = num(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024); // 500 MB

export const cfg = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: num(process.env.PORT, 3000),
  DATABASE_URL: process.env.DATABASE_URL || "",

  B2: {
    KEY_ID: process.env.B2_KEY_ID || "",
    APPLICATION_KEY: process.env.B2_APPLICATION_KEY || "",
    BUCKET: process.env.B2_BUCKET_NAME || "glass-journal",
    ENDPOINT: process.env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com",
    REGION: process.env.B2_REGION || "us-west-004",
  },

  STORAGE_DRIVER: (process.env.STORAGE_DRIVER || "b2").toLowerCase(),
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR || "./local-storage",

  MAX_UPLOAD_BYTES,
  SIGNED_URL_EXPIRES: num(process.env.SIGNED_URL_EXPIRES, 3600),
};

// Quick sanity logs. Fail loud on missing DB in production.
if (cfg.NODE_ENV === "production" && !cfg.DATABASE_URL) {
  throw new Error("Missing required env: DATABASE_URL");
}
if (!cfg.B2.KEY_ID || !cfg.B2.APPLICATION_KEY) {
  if (cfg.STORAGE_DRIVER === "b2") {
    console.warn(
      "[config] B2 credentials missing — uploads will fail until configured. " +
      "Set B2_KEY_ID + B2_APPLICATION_KEY, or use STORAGE_DRIVER=local for dev."
    );
  }
}

export default cfg;