/** 把外部图片 data URL 校验并解码成 AI SDK 可用的媒体类型与字节。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function parseDataUrl(value: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match?.[1] || !match[2] || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase()))
    throw new Error("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
    throw new Error("单张图片不能超过 8 MB");
  return { mediaType: match[1].toLowerCase(), bytes: new Uint8Array(bytes) };
}
