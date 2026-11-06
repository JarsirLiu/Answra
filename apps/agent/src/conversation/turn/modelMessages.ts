/** 将 Conversation 请求和仓储历史转换成 AI SDK 模型上下文。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { ModelMessage } from "ai";
import type { ConversationStore } from "../session/store";
import { parseDataUrl } from "./requestContent";
import { buildTimeReminder } from "./timeReminder";

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
        .map((message) =>
          message.role === "assistant"
            ? { role: "assistant", content: message.text }
            : {
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
              },
        )
    : [{ role: "user", content }];
  if (injectTime) appendTimeReminder(messages);
  return messages;
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
