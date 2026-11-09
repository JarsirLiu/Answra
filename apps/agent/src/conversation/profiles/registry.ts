/** 通用聊天 profile 的类型与静态注册表；不接受 renderer 动态注入策略。 */
import { type ToolId, toolId } from "../../core/tool";

export interface ChatProfile {
  systemPrompt: string;
  includeHistory: boolean;
  tools: readonly ToolId[];
  injectTime?: boolean;
}

export const CHAT_PROFILES = {
  "general-chat": {
    systemPrompt: [
      "你是 Answra 的通用 AI 助手。",
      "根据完整对话上下文回答用户当前问题，保持自然、清晰，并在需要时追问澄清。",
      "涉及文件或目录内容时，先查看实际内容再回答；不要根据文件名或印象猜测。优先使用当前工作区。",
    ].join("\n"),
    includeHistory: true,
    tools: [
      toolId("workspace.read"),
      toolId("workspace.grep"),
      toolId("workspace.run-command"),
      toolId("workspace.write-stdin"),
    ],
    injectTime: true,
  },
} as const satisfies Record<string, ChatProfile>;

export type ChatProfileId = keyof typeof CHAT_PROFILES;
