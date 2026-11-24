/** 对话图片附件的 IPC 边界校验：只判断载荷事实，不持有会话状态。 */
import type { ConversationImage } from "@answra/shared";

/** 单条用户消息可携带的图片上限；与 Agent 侧模型请求约束保持一致。 */
export const MAX_CONVERSATION_IMAGES = 8;

const MAX_IMAGE_NAME_LENGTH = 256;
const MAX_IMAGE_DATA_URL_LENGTH = 11_200_000;
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_DATA_URL_PATTERN = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * 校验 renderer 传来的图片数组并返回可转发的 DTO。
 * 拒绝超量、超长、非受支持媒体类型或非法 data URL 的载荷。
 */
export function parseConversationImages(value: unknown): ConversationImage[] {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_IMAGES)
    throw new Error("单次最多发送 8 张图片");
  return value.map((candidate) => {
    const image = candidate as Partial<ConversationImage> | null;
    if (
      typeof image?.name !== "string" ||
      image.name.length > MAX_IMAGE_NAME_LENGTH ||
      typeof image.dataUrl !== "string" ||
      image.dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH
    )
      throw new Error("图片附件无效或过大");
    const match = IMAGE_DATA_URL_PATTERN.exec(image.dataUrl);
    if (!match?.[1] || !ALLOWED_IMAGE_MEDIA_TYPES.has(match[1]) || !match[2])
      throw new Error("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
    return { name: image.name, dataUrl: image.dataUrl };
  });
}
