/**
 * 演练朗读意图：只把已收口的 assistant 正文投影成 `TtsSpeakIntent`。
 *
 * 不切句、不做 Markdown 净化、不判断 provider；那些属于 `@answra/tts` 与桌面宿主。
 * 首版在 Turn 收口时发一条整段增量，之后改逐帧只需改这里，协议不变。
 */
import type { ConversationMessage, ConversationMessagePart, TtsSpeakIntent } from "@answra/shared";

/** 只有 assistant 正文可朗读；思维链、工具调用与用户消息都不进入朗读。 */
export function rehearsalSpeechIntent(
  conversationId: string,
  message: ConversationMessage,
): TtsSpeakIntent | undefined {
  if (message.role !== "assistant") return undefined;
  const text = speakableText(message);
  if (text === "") return undefined;
  return {
    conversationId,
    messageId: message.id,
    sequence: 0,
    delta: text,
    final: true,
  };
}

/** 拼接全部 text part；没有 parts 时退回消息正文（迁移历史与兼容路径）。 */
export function speakableText(message: ConversationMessage): string {
  const parts = message.parts;
  if (parts === undefined || parts.length === 0) return message.text.trim();
  return parts
    .filter(
      (part): part is Extract<ConversationMessagePart, { kind: "text" }> => part.kind === "text",
    )
    .map((part) => part.text.trim())
    .filter((text) => text !== "")
    .join("\n");
}
