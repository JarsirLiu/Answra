import type { ReactNode } from "react";
import styles from "./AssistantMessage.module.css";
import { MessageActions } from "./MessageActions";
import { TextResponse } from "./TextResponse";
import { ThinkingReasoning } from "./ThinkingReasoning";

interface AssistantMessageProps {
  /** 模型思维链（reasoning part），流式更新；可能为空。 */
  reasoning?: string;
  /** 正文内容；可能为空（思考阶段）。 */
  content?: string;
  /** 思考阶段：思维链仍在流出且回答正文未开始。 */
  thinking?: boolean;
  /** 本条消息仍在流式输出：操作条延迟到回复完毕后出现。 */
  streaming?: boolean;
  /** 正文流式中：正文末尾显示输出光标。 */
  caret?: boolean;
  /** 思考耗时（毫秒）。 */
  thinkingMs?: number;
  /** 回复完成时间，用于操作条的时间显示。 */
  sentAt?: Date;
  /** 操作条回调。 */
  onCopy?: (text: string) => void;
  onVote?: (vote: "up" | "down" | null) => void;
  onReply?: () => void;
  onFork?: () => void;
  /** 追加的自定义部件（如工具调用卡片），按顺序排在正文之后。 */
  children?: ReactNode;
}

/**
 * AI 消息的统一容器：思考、正文、工具等部件按序纵向排布，
 * 用统一的 6px 间距自然衔接；回复完毕后自动显示操作条。
 */
export function AssistantMessage({
  reasoning,
  content,
  thinking = false,
  streaming = false,
  caret = false,
  thinkingMs,
  sentAt,
  onCopy,
  onVote,
  onReply,
  onFork,
  children,
}: AssistantMessageProps) {
  const text = content?.trim();
  const done = !thinking && !streaming && Boolean(text);
  return (
    <div className={styles.stack}>
      {reasoning || thinking ? (
        <ThinkingReasoning
          durationMs={thinkingMs}
          reasoning={reasoning ?? ""}
          thinking={thinking}
        />
      ) : null}
      {text ? <TextResponse caret={caret} text={text} /> : null}
      {children}
      {done ? (
        <MessageActions
          onCopy={onCopy}
          onFork={onFork}
          onReply={onReply}
          onVote={onVote}
          sentAt={sentAt}
          text={text}
        />
      ) : null}
    </div>
  );
}
