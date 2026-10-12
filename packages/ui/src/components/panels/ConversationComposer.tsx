import { ArrowUp, Plus } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { ICON_SM } from "../../tokens";
import "./ConversationComposer.css";

interface ConversationComposerProps {
  value: string;
  placeholder: string;
  inputLabel: string;
  submitDisabled?: boolean;
  disabled?: boolean;
  footerLabel?: string;
  beforeSubmit?: ReactNode;
  children?: ReactNode;
  onValueChange?: (value: string) => void;
  onAddAttachment?: () => void;
  onSubmit?: () => void;
}

export function ConversationComposer({
  value,
  placeholder,
  inputLabel,
  submitDisabled = false,
  disabled = false,
  footerLabel,
  beforeSubmit,
  children,
  onValueChange,
  onAddAttachment,
  onSubmit,
}: ConversationComposerProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled && !submitDisabled) onSubmit?.();
  }

  return (
    <form
      className={`conversation-composer input-surface${disabled ? " is-readonly" : ""}`}
      onSubmit={handleSubmit}
    >
      {children}
      <textarea
        aria-label={inputLabel}
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
        onKeyDown={(event) => {
          if (disabled || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        placeholder={placeholder}
        rows={1}
        value={value}
      />
      <div className="conversation-composer-footer">
        <div className="conversation-composer-leading">
          <button
            aria-label="添加附件"
            className="conversation-composer-icon-button conversation-composer-add"
            disabled={disabled || !onAddAttachment}
            onClick={onAddAttachment}
            title="添加附件"
            type="button"
          >
            <Plus aria-hidden="true" size={ICON_SM} />
          </button>
          {footerLabel && <span>{footerLabel}</span>}
        </div>
        <div className="conversation-composer-actions">
          {beforeSubmit}
          <button
            aria-label="发送消息"
            className="conversation-composer-icon-button conversation-composer-submit"
            disabled={disabled || submitDisabled}
            title="发送消息"
            type="submit"
          >
            <ArrowUp aria-hidden="true" size={ICON_SM} />
          </button>
        </div>
      </div>
    </form>
  );
}
