/** 将 Conversation 请求和仓储历史转换成 AI SDK 模型上下文；会回放历史工具调用与结果。 */
import type {
  ConversationMessage,
  ConversationMessagePart,
  ConversationSendRequest,
} from "@answra/shared";
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import { parseDataUrl } from "../../core/model/imageInput";
import type { ConversationStore } from "../../core/transcript/store";
import { buildTimeReminder } from "./timeReminder";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

/** 为一个回合构造模型上下文；历史只从 ConversationStore 读取。 */
export async function buildModelMessages({
  conversationId,
  request,
  includeHistory,
  injectTime,
  store,
}: {
  conversationId: string;
  request: ConversationSendRequest;
  includeHistory: boolean;
  injectTime: boolean;
  store: ConversationStore;
}): Promise<ModelMessage[]> {
  const content = [
    ...(request.text.trim() ? [{ type: "text" as const, text: request.text }] : []),
    ...request.images.map((image) => {
      const parsed = parseDataUrl(image.dataUrl);
      return { type: "image" as const, image: parsed.bytes, mediaType: parsed.mediaType };
    }),
  ];
  const messages: ModelMessage[] = includeHistory
    ? (await store.load(conversationId)).messages
        .filter((message) => message.status !== "streaming")
        .flatMap((message) =>
          message.role === "assistant"
            ? assistantModelMessages(message)
            : [userModelMessage(message)],
        )
    : [{ role: "user", content }];
  if (injectTime) appendTimeReminder(messages);
  return messages;
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

function appendTimeReminder(messages: ModelMessage[]): void {
  const last = messages[messages.length - 1];
  const reminder = buildTimeReminder();
  if (last && last.role === "user") {
    const previousContent = last.content;
    last.content = [
      ...(typeof previousContent === "string"
        ? [{ type: "text" as const, text: previousContent }]
        : Array.isArray(previousContent)
          ? previousContent
          : []),
      { type: "text", text: reminder },
    ];
    return;
  }
  messages.push({ role: "user", content: [{ type: "text", text: reminder }] });
}
