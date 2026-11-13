/** 上下文压缩状态的稳定文案；桌面与 CLI 共用，不绑定渲染方式。 */
import type { ContextCompactionStatus } from "@answra/shared";

export function contextCompactionLabel(status: ContextCompactionStatus): string {
  switch (status.state) {
    case "idle":
      return "";
    case "started":
      return status.trigger === "auto" ? "开始自动压缩上下文…" : "开始压缩上下文…";
    case "failed":
      return `上下文压缩失败：${status.errorText ?? "未知错误"}；继续使用原历史。`;
    case "succeeded":
      return status.summarizedMessages === undefined
        ? "上下文压缩完成"
        : `上下文压缩完成（${status.summarizedMessages} 条消息）`;
  }
}
