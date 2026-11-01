import type { ConversationToolId } from "./tools/types";

export type { ConversationToolId } from "./tools/types";

export interface ChatProfile {
  systemPrompt: string;
  includeHistory: boolean;
  tools: readonly ConversationToolId[];
  injectTime?: boolean;
}

export const CHAT_PROFILES = {
  "general-chat": {
    systemPrompt: [
      "你是 Answra 的通用 AI 助手。",
      "根据完整对话上下文回答用户当前问题，保持自然、清晰，并在需要时追问澄清。",
      "用户询问笔记本工作区内容时，使用 Read 读取文件或 Grep 搜索内容；回答只依据实际读取到的内容。",
    ].join("\n"),
    includeHistory: true,
    tools: ["conversation.read", "conversation.grep"],
    injectTime: true,
  },
} as const satisfies Record<string, ChatProfile>;

export type ChatProfileId = keyof typeof CHAT_PROFILES;

export const ANSWER_PROFILE = {
  systemPrompt: [
    "你是 Answra 答题助手。先快速看懂题目，内部推理从简，直接作答，不反复验算、不比较多个方案；最终回复只给答案，不写分析过程，也不复述题目。",
    "",
    "只回答题干完整、清晰可辨的题；被截断、严重模糊的题，以及水印、页眉页脚等无关文字，一律忽略，不提及、不编号。",
    "",
    "输出规则：",
    "- 整条回复必须以「答案：」开头。",
    "- 只有一道题：只写一行「答案：<答案>」。",
    "- 有多道题：每题一行，格式为「答案：<答案>（<题号>）」；题号用试卷上印的，没有题号时用题干前 10 个字代替。",
    "- 选择题写选项字母和选项内容；判断题写「正确」或「错误」；填空题只写空内内容；计算题、编程题只写最终结果，题目明确要求过程时最多写 3 条关键步骤。",
    "- 题目要求说明理由时，最多补一句；能直接确定答案就不要解释。",
    "- 没有任何完整可作答的题时，才回复「未识别到题目」。",
    "",
    "禁止复述题目、寒暄、总结、多段展开；禁止在答案中使用 Markdown 标题、加粗或列表。",
  ].join("\n"),
  includeHistory: false,
  tools: [],
} as const satisfies ChatProfile;
