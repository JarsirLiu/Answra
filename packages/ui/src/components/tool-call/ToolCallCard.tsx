import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import styles from "./ToolCallCard.module.css";
import type { ToolCallPart } from "./toolCallPart";
import {
  formatToolInputStreamSize,
  isToolCallError,
  isToolCallRunning,
  TOOL_CALL_STATE_LABEL,
} from "./toolCallPresentation";

interface ToolCallCardProps {
  part: ToolCallPart;
  icon: ReactNode;
  actionLabel: string;
  primary: ReactNode;
  /** 摘要主目标后的附加内容，例如 Edit 的 +N/-N。 */
  summaryExtra?: ReactNode;
  /** 展开后替换主目标；设置后 summaryExtra 默认隐藏，除非提供 expandedSummaryExtra。 */
  expandedPrimary?: ReactNode;
  expandedSummaryExtra?: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
  /** 默认在非 completed 状态显示生命周期词；RunCommand 用 running/ran 取代它。 */
  showState?: boolean;
  /** 运行中给主目标文字套用扫光脉冲，用于等宽命令行动态反馈。 */
  pulsePrimary?: boolean;
  /**
   * 摘要行外观。`row` 是默认的日志行；`search` 把整行渲染成一条只读搜索框，
   * 只用于用户语义上「输入关键词去查」的工具（WebSearch）。
   */
  variant?: "row" | "search";
  children?: ReactNode;
}

/**
 * The single tool call shell: summary row, lifecycle label, and optional detail body.
 * Tool-specific renderers only supply the labels and detail children.
 */
export function ToolCallCard({
  part,
  icon,
  actionLabel,
  primary,
  summaryExtra,
  expandedPrimary,
  expandedSummaryExtra,
  secondary,
  meta,
  showState: showStateProp,
  pulsePrimary = false,
  variant = "row",
  children,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const expandable = children !== undefined;
  const search = variant === "search";
  const running = isToolCallRunning(part.state);
  const showState = showStateProp ?? part.state !== "completed";
  const hasContext = secondary !== undefined || meta !== undefined;
  const expanded = open && expandedPrimary !== undefined;
  const visiblePrimary = expanded ? expandedPrimary : primary;
  const streamedSize =
    part.state === "input-streaming" && part.inputText
      ? formatToolInputStreamSize(part.inputText.length)
      : undefined;
  const visibleSummaryExtra = expanded ? expandedSummaryExtra : (summaryExtra ?? streamedSize);
  // 搜索框不显示动作词，把动作与关键词合成按钮的可读名称，避免只剩一串 URL 似的查询词。
  const headerLabel = search
    ? `${actionLabel}${typeof primary === "string" ? `：${primary}` : ""}`
    : undefined;
  const summary = (
    <>
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
      {search ? null : <span className={styles.action}>{actionLabel}</span>}{" "}
      <span
        className={styles.primary}
        data-running={(pulsePrimary && running) || undefined}
        title={typeof visiblePrimary === "string" ? visiblePrimary : undefined}
      >
        {visiblePrimary}
      </span>{" "}
      {visibleSummaryExtra !== undefined ? (
        <span className={styles.summaryExtra}>{visibleSummaryExtra}</span>
      ) : null}{" "}
      {showState ? (
        <span
          className={styles.state}
          data-error={isToolCallError(part.state) || undefined}
          data-running={running || undefined}
          title={part.errorText}
        >
          {TOOL_CALL_STATE_LABEL[part.state]}
        </span>
      ) : null}
      {expandable ? <ChevronDown aria-hidden="true" className={styles.chevron} size={14} /> : null}
    </>
  );

  return (
    <section className={styles.card} data-state={part.state} data-variant={variant}>
      {expandable ? (
        <button
          aria-expanded={open}
          aria-label={headerLabel}
          className={styles.header}
          data-variant={variant}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className={styles.header} data-variant={variant}>
          {summary}
        </div>
      )}
      {expandable && open ? (
        <div className={styles.body}>
          {hasContext ? (
            <p className={styles.context}>
              {secondary}
              {secondary !== undefined && meta !== undefined ? " · " : null}
              {meta}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}
