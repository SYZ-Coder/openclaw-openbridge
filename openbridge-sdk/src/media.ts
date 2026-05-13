import type { SpringImMediaItem } from "./types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

type ImagePart = { type: "image"; data: string; mimeType: string };

function normalizeMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.includes("/") ? mime : undefined;
}

function normalizeImageMimeType(value: unknown): string | undefined {
  const mime = normalizeMimeType(value);
  return mime?.startsWith("image/") ? mime : undefined;
}

function inferKindFromUrl(url: string, mimeType?: string): "image" | "file" {
  if (mimeType?.toLowerCase().startsWith("image/")) {
    return "image";
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(path)) {
      return "image";
    }
  } catch {
    // Fall through to file.
  }
  return "file";
}

export function normalizeMediaItems(raw: unknown): SpringImMediaItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: SpringImMediaItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    const mimeType = normalizeMimeType(record.mimeType);
    const kind = record.kind === "image" || record.kind === "file" ? record.kind : inferKindFromUrl(url, mimeType);
    result.push({
      kind,
      url,
      fileName: typeof record.fileName === "string" && record.fileName.trim() ? record.fileName.trim() : undefined,
      mimeType,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined,
    });
  }
  return result;
}

export function summarizeMedia(item: SpringImMediaItem): string {
  if (item.kind === "image") {
    return item.url ? `[Image] ${item.url}` : "[Image message]";
  }
  const parts = ["[File]"];
  if (item.fileName) {
    parts.push(`name=${item.fileName}`);
  }
  if (item.mimeType) {
    parts.push(`type=${item.mimeType}`);
  }
  if (item.url) {
    parts.push(`url=${item.url}`);
  }
  if (item.size) {
    parts.push(`size=${item.size}`);
  }
  return parts.join(" ");
}

export function appendMediaSummary(text: string, media?: SpringImMediaItem[]): string {
  const lines = media?.map(summarizeMedia) ?? [];
  return [text.trim(), ...lines].filter(Boolean).join("\n");
}

export async function materializeInboundImages(media?: SpringImMediaItem[]): Promise<{
  images: ImagePart[];
  warnings: string[];
}> {
  const images: ImagePart[] = [];
  const warnings: string[] = [];
  for (const item of media ?? []) {
    if (item.kind !== "image") {
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(item.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_IMAGE_BYTES) {
        throw new Error(`image too large: ${contentLength} bytes`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`image too large: ${buffer.byteLength} bytes`);
      }
      images.push({
        type: "image",
        data: buffer.toString("base64"),
        mimeType:
          normalizeImageMimeType(response.headers.get("content-type")) ??
          normalizeImageMimeType(item.mimeType) ??
          "image/jpeg",
      });
    } catch (err) {
      warnings.push(`${summarizeMedia(item)} => ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { images, warnings };
}

export function mediaFromReplyPayload(payload: {
  mediaUrl?: string;
  mediaUrls?: string[];
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
}): SpringImMediaItem[] {
  const urls = [
    payload.mediaUrl,
    ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
    payload.fileUrl,
  ]
    .filter((url): url is string => typeof url === "string")
    .map((url) => url.trim())
    .filter(Boolean);
  return normalizeMediaItems(
    urls.map((url) => ({
      url,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
    })),
  );
}
