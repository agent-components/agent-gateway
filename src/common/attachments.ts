import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SDKImage } from "@cursor/sdk";
import sharp from "sharp";
import type { ChatAttachment } from "../protocol/types.js";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 75;

export interface PreparedAttachments {
  text: string;
  images: SDKImage[];
}

function fail(message: string): never {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  throw err;
}

function normalizeMime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) return undefined;
  return mime;
}

function safeFileName(name: string): string {
  const base = path.basename(name || "file");
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ ()\-]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("附件路径无效");
  }
}

function decodeBase64(input: string, label: string): Buffer {
  const trimmed = input.trim();
  const payload =
    trimmed.startsWith("data:") && trimmed.includes(",")
      ? trimmed.slice(trimmed.indexOf(",") + 1)
      : trimmed;
  const compact = payload.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    fail(`附件「${label}」不是有效的 base64`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length) fail(`附件「${label}」内容为空`);
  return bytes;
}

function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function storedExtension(originalName: string, mimeType: string): string {
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const mapped = byMime[mimeType];
  if (mapped) return mapped;
  const ext = path.extname(originalName).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return "";
}

function randomStoredName(ext: string): string {
  return randomBytes(16).toString("hex") + ext;
}

/** Shrink images before they are stored or sent to the SDK. */
async function compressImage(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string; compressed: boolean }> {
  try {
    const options = { animated: false, failOn: "error" as const, limitInputPixels: 40_000_000 };
    const meta = await sharp(bytes, options).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    let pipeline = sharp(bytes, options).rotate();
    const resized = width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE;
    if (resized) {
      pipeline = pipeline.resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const keepPng = mimeType === "image/png" && meta.hasAlpha === true;
    const out = keepPng
      ? await pipeline.png({ compressionLevel: 9, palette: true, effort: 8 }).toBuffer()
      : await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    const nextMime = keepPng ? "image/png" : "image/jpeg";
    if (!resized && out.length >= bytes.length) {
      return { bytes, mimeType, compressed: false };
    }
    return { bytes: out, mimeType: nextMime, compressed: true };
  } catch (err) {
    if (typeof err === "object" && err !== null && "status" in err) throw err;
    fail("图片无法压缩");
  }
}

/** Directory for saved attachments. Relative values resolve from the process cwd. */
export function resolveUploadDir(cwd: string): string {
  const configured = process.env.AGENT_GATEWAY_UPLOAD_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (!cwd.trim()) fail("未设置 AGENT_GATEWAY_UPLOAD_DIR 时需要提供 cwd");
  return path.join(path.resolve(cwd), ".agent-gateway", "uploads");
}

function pathForPrompt(cwd: string, abs: string): string {
  if (!cwd.trim()) return abs;
  const rel = path.relative(path.resolve(cwd), abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return abs;
}

/**
 * Every attachment is stored under `AGENT_GATEWAY_UPLOAD_DIR` (or
 * `{cwd}/.agent-gateway/uploads`) with a random filename.
 * Images are compressed first. On create/resume the compressed bytes are also
 * passed to the SDK. Steer is text-only, so those images are only on disk.
 */
export async function prepareAttachments(
  cwd: string,
  text: string,
  attachments: ChatAttachment[] | undefined,
  options?: { inlineImages?: boolean },
): Promise<PreparedAttachments> {
  if (!attachments?.length) {
    return { text, images: [] };
  }
  const inlineImages = options?.inlineImages !== false;
  if (attachments.length > MAX_FILES) {
    fail(`一次最多上传 ${MAX_FILES} 个文件`);
  }

  let total = 0;
  const images: SDKImage[] = [];
  const lines: string[] = [];
  let uploadDir: string | undefined;

  async function saveFile(bytes: Buffer, ext: string): Promise<string> {
    if (!uploadDir) {
      uploadDir = resolveUploadDir(cwd);
      let dirStat;
      try {
        dirStat = await stat(uploadDir);
      } catch {
        dirStat = undefined;
      }
      if (dirStat && !dirStat.isDirectory()) fail("附件目录不是文件夹");
      await mkdir(uploadDir, { recursive: true });
    }
    const stored = randomStoredName(ext);
    const abs = path.join(uploadDir, stored);
    assertInside(uploadDir, abs);
    await writeFile(abs, bytes);
    return pathForPrompt(cwd, abs);
  }

  for (const file of attachments) {
    if (!file || typeof file.name !== "string" || typeof file.data !== "string") {
      fail("附件格式无效：需要 name 与 data（base64）");
    }
    const label = safeFileName(file.name);
    const bytes = decodeBase64(file.data, label);
    if (bytes.length > MAX_FILE_BYTES) fail(`文件「${label}」超过 8MB`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail("附件总大小超过 16MB");

    const sniffed = sniffImageMime(bytes);
    let payload = bytes;
    let mimeType = sniffed ?? normalizeMime(file.mimeType) ?? "application/octet-stream";
    let compressed = false;
    if (sniffed) {
      const image = await compressImage(bytes, sniffed);
      payload = image.bytes;
      mimeType = image.mimeType;
      compressed = image.compressed;
      if (inlineImages) images.push({ data: payload.toString("base64"), mimeType });
    }

    const rel = await saveFile(payload, storedExtension(file.name, mimeType));
    const suffix = sniffed
      ? compressed
        ? inlineImages
          ? "（已压缩，并附在本条消息）"
          : "（已压缩）"
        : inlineImages
          ? "（已附在本条消息）"
          : ""
      : ` (${mimeType})`;
    lines.push(`- ${label} → ${rel}${suffix}`);
  }

  const base = text.trim() || "请查看我上传的文件。";
  const notes: string[] = [];
  if (lines.length) {
    notes.push("[附件已保存]", ...lines, "请用 Read 打开这些路径后再回答。");
  }
  const note = notes.length ? `\n\n${notes.join("\n")}` : "";
  return { text: base + note, images };
}
