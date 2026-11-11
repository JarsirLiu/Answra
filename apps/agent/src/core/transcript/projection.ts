/** 将会话消息按 author/audience 投影为模型消息；纯函数，不依赖任何领域。 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import { parseDataUrl } from "../model/imageInput";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

/** 为一个查看者构造模型上下文；缺省 viewer 时按用户可见的 legacy 历史处理。 */
export function projectConversationMessages({
  messages,
  viewerAgentId,
  agentNames,
}: {
  messages: readonly ConversationMessage[];
  viewerAgentId?: string;
  agentNames?: ReadonlyMap<string, string>;
}): ModelMessage[] {
  if (!viewerAgentId) return messages.filter(isComplete).flatMap(legacyMessage);
  return messages.filter(isComplete).flatMap((message) => {
    if (message.audience?.kind === "bot") {
      if (message.audience.agentId === viewerAgentId)
        return [
          {
            role: "user" as const,
            content: handoffText(message, viewerAgentId, agentNames),
          },
        ];
      if (message.authorAgentId === viewerAgentId)
        return [{ role: "assistant" as const, content: message.text }];
      return [];
    }
    if (message.role === "user") return [userModelMessage(message)];
    if (message.authorAgentId && message.authorAgentId !== viewerAgentId)
      return [{ role: "assistant" as const, content: message.text }];
    return assistantModelMessages(message);
  });
}

function isComplete(message: ConversationMessage): boolean {
  return message.status !== "streaming";
}

function legacyMessage(message: ConversationMessage): ModelMessage[] {
  return message.role === "assistant"
    ? assistantModelMessages(message)
    : [userModelMessage(message)];
}

function handoffText(
  message: ConversationMessage,
  viewerAgentId: string,
  agentNames: ReadonlyMap<string, string> | undefined,
): string {
  // 交接消息一定是 Bot 写的；缺作者时退回当前查看者，避免泄漏未注册 ID。
  const author = message.authorAgentId ?? viewerAgentId;
  const name = agentNames?.get(author) ?? author;
  return `【来自${name}的交接】\n${message.text}`;
}

function userModelMessage(message: ConversationMessage): ModelMessage {
  return {
    role: "user",
    content: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...message.images.map((image) => {
        const parsed = parseDataUrl(image.dataUrl);
        return {
          type: "image" as const,
          image: parsed.bytes,
          mediaType: parsed.mediaType,
        };
      }),
    ],
  };
}

/**
 * 一个 assistant transcript 消息可能包含多轮文本和工具调用。
 * 这里按工具边界拆成成对的 assistant tool-call / tool-result 消息。
 */
function assistantModelMessages(message: ConversationMessage): ModelMessage[] {
  if (!message.parts || message.parts.length === 0) {
    return [{ role: "assistant", content: message.text }];
  }

  const messages: ModelMessage[] = [];
  let content: Array<TextPart | ToolCallPart> = [];
  let results: ToolResultPart[] = [];

  const flush = (): void => {
    if (content.length > 0) {
      messages.push({ role: "assistant", content });
      content = [];
    }
    if (results.length > 0) {
      messages.push({ role: "tool", content: results });
      results = [];
    }
  };

  for (const part of message.parts) {
    if (part.kind === "text") {
      if (!part.text) continue;
      if (results.length > 0) flush();
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.kind === "tool" && part.input !== undefined) {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
      results.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: "text", value: toolResultText(part) },
      });
    }
  }
  flush();

  return messages.length > 0 ? messages : [{ role: "assistant", content: message.text }];
}

function toolResultText(part: ToolPart): string {
  switch (part.state) {
    case "completed":
      return stringifyToolOutput(part.output);
    case "failed":
      return part.errorText ?? "工具执行失败。";
    case "denied":
      return "工具调用被拒绝，没有返回结果。";
    case "interrupted":
      return "工具执行被中断，没有返回结果。";
    default:
      return "工具调用未完成，没有返回结果。";
  }
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "工具执行完成，但没有返回结果。";
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
