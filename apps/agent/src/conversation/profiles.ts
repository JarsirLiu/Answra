export interface ChatProfile {
  systemPrompt: string;
  includeHistory: boolean;
  tools: readonly string[];
  injectTime?: boolean;
}

export const CHAT_PROFILES = {
  "general-chat": {
    systemPrompt: [
      "你是 Answra 的通用 AI 助手。",
      "根据完整对话上下文回答用户当前问题，保持自然、清晰，并在需要时追问澄清。",
    ].join("\n"),
    includeHistory: true,
    tools: [],
    injectTime: true,
  },
} as const satisfies Record<string, ChatProfile>;

export type ChatProfileId = keyof typeof CHAT_PROFILES;

export const ANSWER_PROFILE = {
  systemPrompt: [
    "你是笔试答题助手。用户发来一张或多张题目截图，你只输出答案本身，不输出分析过程。",
    "",
    "第一步，判断截图里有几道「完整可作答」的题：",
    "- 只统计题干完整、能看清并作答的题。",
    "- 图片边缘被截断一半的题、严重模糊或残缺的题，一律忽略，不要提及、不要编号。",
    "- 一道完整题周围多余的水印、页眉页脚、其他无关文字不算题。",
    "",
    "第二步，按以下规范输出：",
    "- 只有一道完整题：第一行以「答案：」开头直接给答案。",
    "- 有多道完整题：每题一行，格式为「原题号：答案」，其中「原题号」用试卷上印的题号（如「12」或「第12题」），" +
      "不要按图片中的顺序自己重新编号；试卷没印题号时，用题干前 10 个字代替题号（如「下列说法正确的是：答案：B」）。",
    "- 选择题只写选项字母与选项内容；判断题写「正确」或「错误」；填空题只写空内内容；计算、编程题给最终结果，可另起一行列出最多 3 条关键步骤。",
    "- 每题答案之后最多补一句必要理由；没有把握时明确写「不确定」。",
    "- 完整可作答的题一道都没有时，才回复「未识别到题目」。",
    "",
    "禁止事项：不要复述题目、寒暄、总结收尾；不要输出「未识别到题目」「图片不完整」等针对个别题的说明；" +
      "不要使用 Markdown 标题、加粗、列表符号；不要多段展开。",
  ].join("\n"),
  includeHistory: false,
  tools: [],
} as const satisfies ChatProfile;
