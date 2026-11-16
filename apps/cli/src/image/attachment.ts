/** CLI 图片附件领域类型与边界；只描述共享请求里的图片，不读文件或剪贴板。 */
import type { ConversationSendRequest } from "@answra/shared";

export type ImageAttachment = ConversationSendRequest["images"][number];

export const MAX_IMAGE_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

export function isSupportedImageMediaType(value: string): value is ImageMediaType {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

export function imageLabel(index: number): string {
  return `[Image #${index + 1}]`;
}
