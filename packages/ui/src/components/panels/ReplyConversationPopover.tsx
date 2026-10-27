import type { DesktopBridge, ReplyBarActivity } from "@answra/shared";
import { isAuthRequiredError } from "@answra/shared";
import { AlertCircle, FileText, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import type { ReplyConversationMessage } from "../../app/useReplyConversation";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
import { ICON_SM } from "../../tokens";
import { AssistantMessage, MessageStream, ModelErrorNotice } from "../chat";
import { ConversationComposer } from "./ConversationComposer";
import "./ReplyConversationPopover.css";

interface ReplyConversationPopoverProps {
  messages: ReplyConversationMessage[];
  activeRunId?: string;
  error?: string;
  placement: "above" | "below";
  stealth: boolean;
  bridge?: DesktopBridge;
  conversationId?: string;
}

/**
 * 回复条展开的对话页：由 chat/ 组合部件拼装——
 * MessageStream（自动跟随 + 定位按钮）+ AssistantMessage（思考/正文/操作条），
 * 工具/来源/错误等自定义活动卡片走 children 插槽。
 */
export function ReplyConversationPopover({
  messages,
  activeRunId,
  error,
  placement,
  stealth,
  bridge,
  conversationId,
}: ReplyConversationPopoverProps) {
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string>();
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const controlledImeText = useControlledImeTextAdapter({
    inputRef: composerInputRef,
    value: draft,
    onChange: setDraft,
  });
  const ime = useEmbeddedIme(bridge, controlledImeText.commit, stealth, "reply-composer");
  const send = async () => {
    const text = draftRef.current.trim();
    if (!text || !conversationId || !bridge?.sendConversationMessage) return;
    setDraft("");
    setSendError(undefined);
    try {
      await bridge.sendConversationMessage({
        operation: "answer.run",
        conversationId,
        request: { text, images: [] },
      });
    } catch (error) {
      // 失败必须回到发送方：草稿还给用户，原因显示在同一处失败提示里。
      setDraft(text);
      setSendError(error instanceof Error ? error.message : "发送失败");
    }
  };
  const signIn = () => {
    void bridge?.loginAccount?.();
  };
  // 同一表面只留一处失败：本轮已有流式 error 活动项时，本节不再重复提示。
  const hasErrorActivity = messages.some((message) =>
    message.activities.some((activity) => activity.kind === "error"),
  );
  const failure = sendError ?? error;
  const failureNeedsSignIn = isAuthRequiredError(sendError ?? "");
  const contentKey = messages
    .map(
      (message) =>
        `${message.id}:${message.text.length}:${message.status}:${message.activities
          .map((item) => `${item.kind}:${item.text.length}`)
          .join(",")}`,
    )
    .join("|");

  return (
    <section
      aria-label="当前对话"
      className="reply-conversation-popover floating-surface"
      data-placement={placement}
    >
      <header className="reply-conversation-header">
        <h2>当前对话</h2>
        {activeRunId && <span className="reply-conversation-live">实时输出</span>}
      </header>
      <MessageStream
        ariaLabel="当前对话"
        contentKey={contentKey}
        viewportClassName="reply-conversation-scroll"
      >
        {messages.map((message) => (
          <article
            className={`reply-conversation-message reply-conversation-message--${message.role}`}
            key={message.id}
          >
            {message.role === "user" ? (
              <div className="reply-conversation-user-content">
                {message.images.map((image) => (
                  <figure className="reply-conversation-image" key={`${message.id}-${image.name}`}>
                    <img alt="题目截图" src={image.dataUrl} />
                  </figure>
                ))}
                {message.text && <p>{message.text}</p>}
              </div>
            ) : (
              <AssistantMessage
                caret={isActive(message, activeRunId) && hasStreamingText(message)}
                content={textContent(message)}
                reasoning={reasoningText(message)}
                streaming={isActive(message, activeRunId)}
                thinking={isActive(message, activeRunId) && !textContent(message).trim()}
              >
                {message.activities
                  .filter((activity) => activity.kind !== "thinking" && activity.kind !== "text")
                  .map((activity) => (
                    <ActivityCard activity={activity} key={`${activity.kind}:${activity.id}`} />
                  ))}
                {message.status === "interrupted" && (
                  <div className="reply-conversation-interrupted">回复已停止</div>
                )}
              </AssistantMessage>
            )}
          </article>
        ))}
        {failure && !hasErrorActivity && (
          <ModelErrorNotice message={failure} onSignIn={failureNeedsSignIn ? signIn : undefined} />
        )}
        {messages.length === 0 && !failure && (
          <p className="reply-conversation-empty">发送后将在这里显示本轮对话</p>
        )}
      </MessageStream>
      <ConversationComposer
        compact
        disabled={false}
        inputLabel="消息输入"
        inputRef={composerInputRef}
        nonActivating={stealth}
        onSubmit={() => void send()}
        onValueChange={setDraft}
        placeholder="继续输入消息…"
        showImeToggle={false}
        submitDisabled={!draft.trim()}
        value={draft}
        ime={ime.available ? { session: ime, composition: controlledImeText } : undefined}
      />
    </section>
  );
}

function isActive(message: ReplyConversationMessage, activeRunId: string | undefined): boolean {
  return message.id === activeRunId && message.status === "streaming";
}

function reasoningText(message: ReplyConversationMessage): string {
  return message.activities
    .filter((activity) => activity.kind === "thinking")
    .map((activity) => activity.text)
    .filter(Boolean)
    .join("\n\n");
}

function textContent(message: ReplyConversationMessage): string {
  const parts = message.activities
    .filter((activity) => activity.kind === "text")
    .map((activity) => activity.text)
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : message.text;
}

function hasStreamingText(message: ReplyConversationMessage): boolean {
  const last = message.activities[message.activities.length - 1];
  return last?.kind === "text";
}

function ActivityCard({ activity }: { activity: ReplyBarActivity }) {
  if (activity.kind === "status" && !activity.text) return null;
  const Icon =
    activity.kind === "tool" ? Wrench : activity.kind === "source" ? FileText : AlertCircle;
  return (
    <div className={`reply-conversation-activity reply-conversation-activity--${activity.kind}`}>
      <Icon aria-hidden="true" size={ICON_SM} />
      <div className="reply-conversation-activity-body">
        <strong>{activity.label}</strong>
        {activity.text && <p>{activity.text}</p>}
      </div>
    </div>
  );
}
