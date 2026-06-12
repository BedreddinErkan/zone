import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface ImageAttachment {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

export type AttachmentValidationResult =
  | { ok: true; attachments: ImageAttachment[] }
  | { ok: false; error: string };

const ALLOWED_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MAX_IMAGES = 4;
const MAX_PER_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export function validateAttachments(raw: unknown): AttachmentValidationResult {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return { ok: true, attachments: [] };
  }
  if (raw.length > MAX_IMAGES) {
    return { ok: false, error: `Too many images (max ${MAX_IMAGES})` };
  }

  const attachments: ImageAttachment[] = [];
  let totalBytes = 0;

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Invalid attachment format" };
    }
    const { mediaType, base64 } = item as Record<string, unknown>;
    if (typeof mediaType !== "string" || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, error: `Unsupported image type: ${String(mediaType)}` };
    }
    if (typeof base64 !== "string" || base64.length === 0) {
      return { ok: false, error: "Missing base64 data" };
    }
    // Approximate decoded byte length (base64 is ~4/3 of raw bytes).
    const byteLength = Math.ceil((base64.length * 3) / 4);
    if (byteLength > MAX_PER_IMAGE_BYTES) {
      return { ok: false, error: "An image exceeds the 5 MB per-image limit" };
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: "Total image size exceeds the 16 MB limit" };
    }
    attachments.push({
      mediaType: mediaType as ImageAttachment["mediaType"],
      base64,
    });
  }

  return { ok: true, attachments };
}

const EXT_TO_MEDIA_TYPE: Record<string, ImageAttachment["mediaType"]> = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

/** Resolves the media type from a file path extension, or throws for unsupported types. */
export function getMediaType(fp: string): ImageAttachment["mediaType"] {
  const ext = extname(fp).toLowerCase();
  const mediaType = EXT_TO_MEDIA_TYPE[ext];
  if (!mediaType) {
    throw new Error(`Unsupported image type: ${ext || "(no extension)"} — use jpg, png, gif, or webp`);
  }
  return mediaType;
}

/** Reads a local image file and returns an ImageAttachment ready for validation and use. */
export async function readImageFromFile(fp: string): Promise<ImageAttachment> {
  const mediaType = getMediaType(fp);
  const buf = await readFile(fp);
  const base64 = buf.toString("base64");
  return { mediaType, base64 };
}
