/** 对话附件的浏览器侧转换：File ↔ 预览 URL 与模型图片载荷；只做数据换算，不持有发送状态。 */
import type { ConversationImage } from "@answra/shared";
import type { ChatAttachment } from "../components/panels/ChatPanel";

/** 只接受图片文件；非图片返回 null，由调用方保持静默忽略。 */
export function createAttachment(file: File): ChatAttachment | null {
  if (!file.type.startsWith("image/")) return null;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    previewUrl: URL.createObjectURL(file),
  };
}

/** 释放预览用的 blob URL；data URL 不占用对象 URL。 */
export function revokeAttachment(attachment: ChatAttachment): void {
  if (attachment.previewUrl.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
}

/** 把附件转成跨进程图片载荷；预览已是 data URL 时直接复用，避免二次编码。 */
export async function attachmentToImage(attachment: ChatAttachment): Promise<ConversationImage> {
  return {
    name: attachment.name,
    dataUrl: attachment.previewUrl.startsWith("data:")
      ? attachment.previewUrl
      : await blobUrlToDataUrl(attachment.previewUrl),
  };
}

async function blobUrlToDataUrl(url: string): Promise<string> {
  const blob = await fetch(url).then((response) => response.blob());
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}
