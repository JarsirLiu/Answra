/** 将 Conversation 请求和仓储历史转换成 AI SDK 模型上下文。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { ModelMessage } from "ai";
import { projectContextMessages } from "../../core/context/projection";
import { parseDataUrl } from "../../core/model/imageInput";
import { latestCheckpoint } from "../../core/transcript/contextCheckpoint";
import { projectConversationMessages } from "../../core/transcript/projection";
import type { ConversationStore } from "../../core/transcript/store";

/** 为一个回合构造模型上下文；历史只从 ConversationStore 读取。 */
export async function buildModelMessages({
  conversationId,
  request,
  includeHistory,
  store,
  viewerAgentId,
  agentNames,
}: {
  conversationId: string;
  request: ConversationSendRequest;
  includeHistory: boolean;
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
  const snapshot = includeHistory ? await store.load(conversationId) : undefined;
  const messages: ModelMessage[] =
    snapshot === undefined
      ? [{ role: "user", content }]
      : projectContextMessages({
          messages: snapshot.messages,
          checkpoint: latestCheckpoint(await store.loadContextState(conversationId)),
          project: (tail) =>
            projectConversationMessages({
              messages: tail,
              ...(viewerAgentId ? { viewerAgentId } : {}),
              ...(agentNames ? { agentNames } : {}),
              ...(snapshot.activeMessageId === undefined
                ? {}
                : { activeMessageId: snapshot.activeMessageId }),
            }),
        });
  return messages;
}
