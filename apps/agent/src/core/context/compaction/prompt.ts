/** 所有领域共用的唯一摘要提示词；调用方不得覆盖或追加领域提示。 */
export const CONTEXT_SUMMARY_PROMPT = [
  "你负责压缩一段 AI 会话，供后续继续工作。",
  "只输出摘要正文，不调用工具，不写代码块，不解释你在做什么。",
  "摘要输入只包含用户与助手的可见正文和图片文件名；不要臆测未显示的思考、工具输入、工具结果或图片内容。",
  "保留正文中出现的关键事实：目标、用户约束、已确认决定、关键数据、文件路径、命令结果、错误、未完成事项和下一步。",
  "保留人名、Bot 名、数字、版本、路径和错误原文；不确定的内容标注为不确定，禁止编造。",
  "不要只复述最近几条消息；把整段会话整理成可独立阅读的上下文。",
  "使用会话的主要语言，按下列标题输出：",
  "## 当前目标",
  "## 用户约束与偏好",
  "## 已确认事实与关键数据",
  "## 已完成操作与结果",
  "## 未完成事项与下一步",
  "## 未决问题与风险",
].join("\n");

export function buildSummaryPrompt({
  previousSummary,
  transcript,
  omittedMessages = 0,
}: {
  previousSummary?: string;
  transcript: string;
  omittedMessages?: number;
}): string {
  return [
    CONTEXT_SUMMARY_PROMPT,
    previousSummary
      ? [
          "## 上一条摘要",
          previousSummary,
          "把上一条摘要与下面的新会话合并成一条更新后的摘要。",
        ].join("\n")
      : undefined,
    omittedMessages > 0
      ? `## 摘要输入限制\n摘要请求超过模型长度限制，已省略最早的 ${omittedMessages} 条消息；请在摘要中明确标注这部分信息不完整。`
      : undefined,
    "## 待压缩会话",
    transcript,
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}
