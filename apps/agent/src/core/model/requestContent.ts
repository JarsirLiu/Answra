/** Validates model request text and image inputs shared by Chat, Answer and interview intake. */
import type { ConversationImage } from "@answra/shared";
import { parseDataUrl } from "./imageInput";

/** 只关心文本与图片本身；readonly 允许 worker 协议直接传入，不复制数组。 */
export interface ModelRequestContent {
  text: string;
  images: readonly ConversationImage[];
}

export function validateModelRequest(request: ModelRequestContent): void {
  if (typeof request.text !== "string" || request.text.length > 32_000)
    throw new Error("消息内容无效或过长");
  if (!Array.isArray(request.images) || request.images.length > 8)
    throw new Error("单次最多发送 8 张图片");
  for (const image of request.images) {
    if (
      typeof image.name !== "string" ||
      image.name.length > 256 ||
      typeof image.dataUrl !== "string"
    )
      throw new Error("图片附件无效");
    parseDataUrl(image.dataUrl);
  }
}
