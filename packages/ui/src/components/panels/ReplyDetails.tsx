import type { DesktopBridge } from "@answra/shared";
import { useReplyConversation } from "../../app/useReplyConversation";
import { ReplyConversationPopover } from "./ReplyConversationPopover";

interface ReplyDetailsProps {
  conversationId?: string;
  bridge?: DesktopBridge;
  stealth: boolean;
}

/**
 * 回复条展开的详情面板：订阅本轮截图会话，在悬浮导航条下方渲染对话流。
 * 只在展开时挂载，收起即卸载，避免常驻订阅。
 */
export function ReplyDetails({ conversationId, bridge, stealth }: ReplyDetailsProps) {
  const conversation = useReplyConversation(bridge, conversationId, true);
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
