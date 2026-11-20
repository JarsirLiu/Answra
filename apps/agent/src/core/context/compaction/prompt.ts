/** 所有领域共用的唯一摘要提示词；领域不得覆盖；手动用户指令由 buildSummaryPrompt 统一追加。 */
export const CONTEXT_SUMMARY_PROMPT = [
  "你负责把一段 AI 会话压缩成可供另一个模型继续工作的摘要。",
  "只输出摘要正文，不调用工具，不解释过程。",
  "",
  "优先保留：当前目标、用户约束、已确认决定、未完成事项与下一步；文件路径、命令、错误原文、关键数字/版本、验证结论；影响判断的风险。",
  "明确记录已完成的有副作用操作（写文件、提交、发消息、运行命令），供后续模型避免重复执行。",
  "可以省略：寒暄、重复解释、与结论无关的探索过程、大段工具输出和代码。工具结果只留结论和必要的路径/命令/错误原文。",
  "不要复述原始对话，直接给结论；不确定的内容标注为不确定，禁止编造。",
  "不要输出 API Key、令牌、密码等敏感值；必须提及时用占位符。",
  "使用会话的主要语言，按下列标题输出；没有内容的标题可以省略：",
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
    "只输出压缩后的摘要正文，不解释、不调用工具、不输出大段代码。",
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
