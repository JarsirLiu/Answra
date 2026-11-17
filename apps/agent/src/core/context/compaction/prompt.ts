/** 所有领域共用的唯一摘要提示词；领域不得覆盖；手动用户指令由 buildSummaryPrompt 统一追加。 */
export const CONTEXT_SUMMARY_PROMPT = [
  "你负责压缩一段 AI 会话，供后续继续工作。",
  "只输出摘要正文，不调用工具，不写代码块，不解释你在做什么。",
  "摘要输入包含用户/助手正文、图片文件名，以及经过截断的工具调用和工具结果；不要臆测未显示的思考、未提供的工具细节或图片内容。",
  "必须保留工具结果中出现的文件路径、命令、错误原文和验证结论；工具结果被截断时标注其不完整。",
  "保留关键事实：目标、用户约束、已确认决定、关键数据、未完成事项和下一步。",
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

/** 摘要超过预算时的二次收敛提示；只缩短，不引入新事实。 */
export function buildSummaryShorteningPrompt({
  summary,
  maxTokens,
}: {
  summary: string;
  maxTokens: number;
}): string {
  return [
    "你负责把一份会话摘要压缩到给定 token 预算内，供另一个模型继续工作。",
    "只输出压缩后的摘要正文，不解释、不调用工具、不写代码块。",
    `目标上限：${maxTokens} token。`,
    "必须保留：当前目标、用户约束、已改文件路径、命令与错误原文、验证结论、未完成事项和下一步。",
    "不得新增原摘要没有的事实；不确定的内容继续标注为不确定。",
    "## 原摘要",
    summary,
  ].join("\n\n");
}

export function buildSummaryPrompt({
  previousSummary,
  transcript,
  omittedMessages = 0,
  instructions,
}: {
  previousSummary?: string;
  transcript: string;
  omittedMessages?: number;
  /** 用户手动 `/compact` 附带的一次性摘要偏好；不得覆盖基础事实与隐私约束。 */
  instructions?: string;
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
    instructions
      ? [
          "## 用户附加摘要指令",
          instructions,
          "这些指令只影响摘要重点、详略和格式；仍必须遵守上面的只输出摘要、事实准确、不编造和隐私约束。",
        ].join("\n")
      : undefined,
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}
