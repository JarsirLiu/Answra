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
