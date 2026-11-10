import type { AgentConnectionState, DesktopBridge } from "@answra/shared";
import type { ConversationView } from "../../app/conversationView";
import type { ReplyConversationMessage } from "../../app/useReplyConversation";
import { ReplyConversationPopover } from "./ReplyConversationPopover";

interface ReplyDetailsProps {
  bridge?: DesktopBridge;
  /** 主回复投影；详情面板只渲染这份状态，不建立第二个事件订阅。 */
  conversation: Pick<ConversationView, "messages" | "activeRunId" | "retry" | "error">;
  /** 本轮失败提示；与订阅错误合并，调用方传入的内容优先。 */
  error?: string;
  /** Agent worker 链路状态；与模型重试/错误互斥展示。 */
  connection?: AgentConnectionState;
  /** 是否展示详情面板。 */
  expanded: boolean;
  stealth: boolean;
}

/**
 * 回复条展开的详情面板：全程订阅本轮截图会话，展开时在悬浮导航条下方渲染对话流。
 * 收起只隐藏 UI、不卸载订阅，避免成功轮在运行时清空后取不到内容。
 */
export function ReplyDetails({
  bridge,
  error,
  connection,
  expanded,
  stealth,
  conversation,
}: ReplyDetailsProps) {
  if (!expanded) return null;
  return (
    <ReplyConversationPopover
      messages={conversation.messages.map(
        (message): ReplyConversationMessage => ({
          ...message,
          activities: message.activities ?? [],
        }),
      )}
      activeRunId={conversation.activeRunId}
      retry={conversation.retry}
      error={error ?? conversation.error}
      connection={connection}
      placement="below"
      stealth={stealth}
      bridge={bridge}
    />
  );
}
