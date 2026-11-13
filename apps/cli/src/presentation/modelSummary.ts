/** 模型设置到纯文本/行的投影；不读取文件、不写状态。 */
import type { ModelSettingsSnapshot } from "../model/ports";

export function modelSummaryLines(snapshot: ModelSettingsSnapshot): readonly string[] {
  return [
    `source: ${snapshot.source}`,
    `baseUrl: ${snapshot.local.baseUrl}`,
    `chatModel: ${snapshot.local.chatModel}`,
    `answerModel: ${snapshot.local.answerModel ?? ""}`,
    `configured: ${snapshot.configured ? "true" : "false"}`,
  ];
}

export function formatModelSummary(snapshot: ModelSettingsSnapshot): string {
  return `${modelSummaryLines(snapshot).join("\n")}\n`;
}
