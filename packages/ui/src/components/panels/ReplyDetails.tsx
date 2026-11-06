import type { DesktopBridge } from "@answra/shared";
import { useReplyConversation } from "../../app/useReplyConversation";
import { ReplyConversationPopover } from "./ReplyConversationPopover";

interface ReplyDetailsProps {
  conversationId?: string;
  bridge?: DesktopBridge;
  /** 本轮失败提示；与订阅错误合并，调用方传入的内容优先。 */
  error?: string;
  /**
   * 是否订阅本轮会话。只要 reply slot 还持有本轮会话（conversationId 存在）就为 true：
   * 答题会话是 ephemeral 的，成功轮在运行结束即被清空，失败轮会保留到关闭回复条或
   * 下一轮开始。因此必须全程订阅、靠增量事件累积，不能在展开时才取快照。
   */
  enabled: boolean;
  /** 是否展示详情面板；收起时保持挂载与订阅，只隐藏界面。 */
  expanded: boolean;
  stealth: boolean;
}

/**
 * 回复条展开的详情面板：全程订阅本轮截图会话，展开时在悬浮导航条下方渲染对话流。
 * 收起只隐藏 UI、不卸载订阅，避免成功轮在运行时清空后取不到内容。
 */
export function ReplyDetails({
  conversationId,
  bridge,
  error,
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
      retry={conversation.retry}
      error={error ?? conversation.error}
      placement="below"
      stealth={stealth}
      bridge={bridge}
    />
  );
}
