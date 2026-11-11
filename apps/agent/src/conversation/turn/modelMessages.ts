/** 将 Conversation 请求和仓储历史转换成 AI SDK 模型上下文。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { ModelMessage } from "ai";
import { parseDataUrl } from "../../core/model/imageInput";
import { projectConversationMessages } from "../../core/transcript/projection";
import type { ConversationStore } from "../../core/transcript/store";
import { buildTimeReminder } from "./timeReminder";

/** 为一个回合构造模型上下文；历史只从 ConversationStore 读取。 */
export async function buildModelMessages({
  conversationId,
  request,
  includeHistory,
  injectTime,
  store,
  viewerAgentId,
  agentNames,
}: {
  conversationId: string;
  request: ConversationSendRequest;
  includeHistory: boolean;
  injectTime: boolean;
  store: ConversationStore;
  /** 当前发言 Bot；设置后按 author/audience 过滤并投影交接记录。 */
  viewerAgentId?: string;
  /** Bot 展示名；交接消息按来源名渲染。 */
  agentNames?: ReadonlyMap<string, string>;
}): Promise<ModelMessage[]> {
  const content = [
    ...(request.text.trim() ? [{ type: "text" as const, text: request.text }] : []),
    ...request.images.map((image) => {
      const parsed = parseDataUrl(image.dataUrl);
      return { type: "image" as const, image: parsed.bytes, mediaType: parsed.mediaType };
    }),
  ];
  const messages: ModelMessage[] = includeHistory
    ? projectConversationMessages({
        messages: (await store.load(conversationId)).messages,
        ...(viewerAgentId ? { viewerAgentId } : {}),
        ...(agentNames ? { agentNames } : {}),
      })
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
