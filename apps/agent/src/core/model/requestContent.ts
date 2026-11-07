/** Validates model request text and image inputs shared by Chat and Answer applications. */
import type { ConversationSendRequest } from "@answra/shared";
import { parseDataUrl } from "./imageInput";

export function validateModelRequest(request: ConversationSendRequest): void {
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
