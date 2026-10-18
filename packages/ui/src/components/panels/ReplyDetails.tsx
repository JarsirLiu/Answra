import type { DesktopBridge } from "@answra/shared";
import { useReplyConversation } from "../../app/useReplyConversation";
import { ReplyConversationPopover } from "./ReplyConversationPopover";

interface ReplyDetailsProps {
  conversationId?: string;
  bridge?: DesktopBridge;
  /**
   * 是否订阅本轮会话。只要 reply slot 还持有本轮会话（conversationId 存在）就为 true：
   * 答题会话是 ephemeral 的，运行结束即在运行时被清空，完成态（乃至收起回发送条后）
   * 再取快照只会拿到空会话，只有在流式期间就订阅、靠增量事件累积才有内容。
   * 退出 reply slot 时组件卸载，本轮内容才随之清空。
   */
  enabled: boolean;
  /** 是否展示详情面板；收起时保持挂载与订阅，只隐藏界面。 */
  expanded: boolean;
  stealth: boolean;
}

/**
 * 回复条展开的详情面板：全程订阅本轮截图会话，展开时在悬浮导航条下方渲染对话流。
 * 收起只隐藏 UI、不卸载订阅，避免完成态会话被运行时清空后取不到内容。
 */
export function ReplyDetails({
  conversationId,
  bridge,
  enabled,
  expanded,
  stealth,
}: ReplyDetailsProps) {
  const conversation = useReplyConversation(bridge, conversationId, enabled);
  if (!expanded) return null;
  return (
    <ReplyConversationPopover
      messages={conversation.messages}
      activeRunId={conversation.activeRunId}
      error={conversation.error}
      placement="below"
      stealth={stealth}
      bridge={bridge}
      conversationId={conversationId}
    />
  );
}
