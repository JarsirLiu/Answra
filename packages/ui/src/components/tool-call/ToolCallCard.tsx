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
  secondary?: ReactNode;
  meta?: ReactNode;
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
  secondary,
  meta,
  children,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const expandable = children !== undefined;
  const showState = part.state !== "completed";
  const hasContext = secondary !== undefined || meta !== undefined;
  const summary = (
    <>
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
      <span className={styles.action}>{actionLabel}</span>
      <span className={styles.primary} title={typeof primary === "string" ? primary : undefined}>
        {primary}
      </span>
      {showState ? (
        <span
          className={styles.state}
          data-error={isToolCallError(part.state) || undefined}
          data-running={isToolCallRunning(part.state) || undefined}
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
