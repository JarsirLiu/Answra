/** Codex 的上下文检查点压缩提示词，来源于 codex-rs/prompts/templates/compact/prompt.md。 */
export const CONTEXT_SUMMARY_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  'Treat "[旧工具结果已清理]" as unavailable content; do not guess or reconstruct it.',
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
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
    "You are shortening a context checkpoint summary for another LLM.",
    "Only output the shortened summary; do not explain, call tools, or add facts.",
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
    previousSummary ? ["Previous checkpoint summary:", previousSummary].join("\n") : undefined,
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
