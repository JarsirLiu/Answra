import type { ReplyBarActivity } from "@answra/shared";
import { AlertCircle, FileText, Wrench } from "lucide-react";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { ReplyConversationMessage } from "../../app/useReplyConversation";
import { ICON_SM } from "../../tokens";
import {
  AicssMarkdown,
  AicssStreamingText,
  AicssTextResponse,
  AicssThinkingReasoning,
  AicssThinkingState,
} from "./AicssConversationPrimitives";
import { ConversationComposer } from "./ConversationComposer";
import { MessageActions } from "./message-actions/MessageActions";
import "./ReplyConversationPopover.css";

interface ReplyConversationPopoverProps {
  messages: ReplyConversationMessage[];
  activeRunId?: string;
  error?: string;
  placement: "above" | "below";
  stealth: boolean;
}

export function ReplyConversationPopover({
  messages,
  activeRunId,
  error,
  placement,
  stealth,
}: ReplyConversationPopoverProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const scrollKey = messages
    .map(
      (message) =>
        `${message.id}:${message.text.length}:${message.activities.map((item) => `${item.id}:${item.text.length}`).join(",")}`,
    )
    .join("|");

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (scrollKey && viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, [scrollKey]);

  const followRevealedText = useCallback(() => {
    const viewport = scrollRef.current;
    if (followLatest.current && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

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
      <div
        className="reply-conversation-scroll"
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followLatest.current =
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 40;
        }}
        ref={scrollRef}
        role="log"
        aria-live="off"
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
              <div className="reply-conversation-assistant-content">
                {message.activities.map((activity, index) =>
                  activity.kind === "text" ? (
                    <MessageTextBlock
                      activity={activity}
                      key={`${activity.kind}:${activity.id}`}
                      onReveal={followRevealedText}
                      streaming={
                        message.id === activeRunId &&
                        message.status === "streaming" &&
                        index === lastTextActivityIndex(message.activities)
                      }
                    />
                  ) : (
                    <Activity
                      activity={activity}
                      isActive={
                        activity.kind === "thinking" &&
                        message.id === activeRunId &&
                        message.status === "streaming" &&
                        index === message.activities.length - 1
                      }
                      key={`${activity.kind}:${activity.id}`}
                    />
                  ),
                )}
                {!message.activities.some((activity) => activity.kind === "text") &&
                  message.text && (
                    <MessageTextBlock
                      activity={{
                        id: `${message.id}:text`,
                        kind: "text",
                        label: "",
                        text: message.text,
                      }}
                      onReveal={followRevealedText}
                      streaming={message.id === activeRunId && message.status === "streaming"}
                    />
                  )}
                {!message.text &&
                  !message.activities.some((activity) => activity.kind === "thinking") &&
                  message.id === activeRunId && <AicssThinkingState />}
                {message.status === "interrupted" && (
                  <div className="reply-conversation-interrupted">回复已停止</div>
                )}
                {message.status === "complete" &&
                  message.text.trim() &&
                  !message.activities.some((activity) => activity.kind === "error") && (
                    <div className="reply-conversation-message-actions">
                      <MessageActions text={message.text} />
                    </div>
                  )}
              </div>
            )}
          </article>
        ))}
        {error &&
          !messages.some((message) =>
            message.activities.some((activity) => activity.kind === "error"),
          ) && (
            <div className="reply-conversation-error" role="alert">
              <AlertCircle aria-hidden="true" size={ICON_SM} />
              <span>{error}</span>
            </div>
          )}
        {messages.length === 0 && !error && (
          <p className="reply-conversation-empty">发送后将在这里显示本轮对话</p>
        )}
      </div>
      <ConversationComposer
        disabled
        inputLabel="消息输入"
        placeholder={stealth ? "隐身模式下不可输入" : "当前对话为只读"}
        value=""
      />
    </section>
  );
}

function lastTextActivityIndex(activities: ReplyBarActivity[]): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.kind === "text") return index;
  }
  return -1;
}

function MessageTextBlock({
  activity,
  streaming,
  onReveal,
}: {
  activity: ReplyBarActivity;
  streaming: boolean;
  onReveal: () => void;
}) {
  return (
    <AicssStreamingText
      onReveal={onReveal}
      streaming={streaming}
      text={activity.text}
      render={(visibleText) =>
        visibleText ? (
          <AicssTextResponse>
            <AicssMarkdown text={visibleText} />
          </AicssTextResponse>
        ) : (
          <AicssThinkingState />
        )
      }
    />
  );
}

function Activity({
  activity,
  isActive = false,
}: {
  activity: ReplyBarActivity;
  isActive?: boolean;
}) {
  if (activity.kind === "status" && !activity.text) return null;
  if (activity.kind === "thinking")
    return <AicssThinkingReasoning isActive={isActive} text={activity.text} />;
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
