// src/lib/media.js — mime detection + classification for the allowed kinds.
// Detects via magic bytes (file-type), then maps to internal "type" used in Media.type.
import { fileTypeFromBuffer } from "file-type";

// Allowed external mimes per spec — image / video / audio / file / apk / voice_note.
// Note: voice_note is treated as audio/mp4 or audio/webm etc. — we just label any
// small audio blob as "voice_note" if it has "voice" in the filename, else "audio".
const ALLOWED = [
  // images
  { mimes: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"], kind: "image" },
  // video
  { mimes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo"], kind: "video" },
  // audio (voice_note handled at route level via filename hint)
  { mimes: ["audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "audio/x-m4a"], kind: "audio" },
  // apk
  { mimes: ["application/vnd.android.package-archive", "application/java-archive"], kind: "apk" },
  // generic files (pdf, zip, docx — same as v1)
  { mimes: ["application/pdf", "application/zip", "application/x-zip-compressed"], kind: "file" },
];

export const ALLOWED_MIMES = ALLOWED.flatMap((g) => g.mimes);

export async function detectMediaType(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: "empty_file" };
  }
  const detected = await fileTypeFromBuffer(buffer);
  // Special case: APK files are ZIP magic bytes — file-type reports "application/zip" for them.
  // The caller can hint via filename; we check both here.
  const mime = detected?.mime || "application/octet-stream";
  for (const group of ALLOWED) {
    if (group.mimes.includes(mime)) {
      return { ok: true, mime, ext: detected?.ext || "bin", kind: group.kind };
    }
  }
  return { ok: false, reason: `unsupported_type:${mime}`, mime };
}

/**
 * Decide the final Media.type value. If kind is "audio" and filename suggests
 * voice (e.g. contains "voice", "voice-note", ".m4a" + small), use "voice_note".
 * Otherwise just return kind.
 */
export function finalizeMediaType(kind, filename, sizeBytes) {
  if (kind === "audio") {
    const lower = (filename || "").toLowerCase();
    if (
      lower.includes("voice") ||
      lower.includes("voicenote") ||
      lower.includes("voice-note") ||
      lower.includes("recording")
    ) {
      return "voice_note";
    }
  }
  if (kind === "apk") return "apk";
  return kind;
}

export function sanitizeFilenameForKey(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "file";
}