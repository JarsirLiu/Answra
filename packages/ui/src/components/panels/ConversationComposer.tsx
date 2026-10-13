import { ArrowUp, Plus } from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { ICON_SM } from "../../tokens";
import "./ConversationComposer.css";

interface ConversationComposerProps {
  value: string;
  placeholder: string;
  inputLabel: string;
  submitDisabled?: boolean;
  disabled?: boolean;
  /** 流式进行中：发送按钮切换为停止按钮。 */
  streaming?: boolean;
  children?: ReactNode;
  /** 外部持有输入框引用（如消息操作条的"引用回复"聚焦）。 */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onValueChange?: (value: string) => void;
  onAddAttachment?: () => void;
  onSubmit?: () => void;
  /** 停止当前回复（streaming 时替换发送按钮）。 */
  onStop?: () => void;
}

export function ConversationComposer({
  value,
  placeholder,
  inputLabel,
  submitDisabled = false,
  disabled = false,
  streaming = false,
  children,
  inputRef,
  onValueChange,
  onAddAttachment,
  onSubmit,
  onStop,
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
        ref={inputRef}
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
        </div>
        <div className="conversation-composer-actions">
          {streaming ? (
            <button
              aria-label="停止回复"
              className="conversation-composer-icon-button conversation-composer-stop"
              onClick={onStop}
              title="停止回复"
              type="button"
            >
              <span aria-hidden="true" className="conversation-composer-stop-glyph" />
            </button>
          ) : (
            <button
              aria-label="发送消息"
              className="conversation-composer-icon-button conversation-composer-submit"
              disabled={disabled || submitDisabled}
              title="发送消息"
              type="submit"
            >
              <ArrowUp aria-hidden="true" size={ICON_SM} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
