import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import styles from "./ToolCallCard.module.css";
import type { ToolCallPart } from "./toolCallPart";
import { isToolCallError, isToolCallRunning, TOOL_CALL_STATE_LABEL } from "./toolCallPresentation";

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
  children,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const expandable = children !== undefined;
  const running = isToolCallRunning(part.state);
  const showState = showStateProp ?? part.state !== "completed";
  const hasContext = secondary !== undefined || meta !== undefined;
  const expanded = open && expandedPrimary !== undefined;
  const visiblePrimary = expanded ? expandedPrimary : primary;
  const visibleSummaryExtra = expanded ? expandedSummaryExtra : summaryExtra;
  const summary = (
    <>
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
      <span className={styles.action}>{actionLabel}</span>{" "}
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
    <section className={styles.card} data-state={part.state}>
      {expandable ? (
        <button
          aria-expanded={open}
          className={styles.header}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className={styles.header}>{summary}</div>
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
