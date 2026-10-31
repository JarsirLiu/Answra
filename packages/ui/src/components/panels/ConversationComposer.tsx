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
  compact?: boolean;
  streaming?: boolean;
  streamingStopLabel?: string;
  children?: ReactNode;
  leadingAction?: ReactNode;
  liveContent?: ReactNode;
  showAttachmentButton?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onValueChange?: (value: string) => void;
  onPasteImages?: (files: File[]) => void;
  onAddAttachment?: () => void;
  onSubmit?: () => void;
  onStop?: () => void;
}

export function ConversationComposer({
  value,
  placeholder,
  inputLabel,
  submitDisabled = false,
  disabled = false,
  compact = false,
  streaming = false,
  streamingStopLabel = "停止回复",
  children,
  leadingAction,
  liveContent,
  showAttachmentButton = true,
  inputRef,
  onValueChange,
  onPasteImages,
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
      className={`conversation-composer input-surface${compact ? " is-compact" : ""}${disabled ? " is-readonly" : ""}`}
      onSubmit={handleSubmit}
    >
      {children}
      <div className="conversation-composer-editor">
        {liveContent ?? (
          <textarea
            aria-label={inputLabel}
            disabled={disabled}
            onChange={(event) => onValueChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (disabled || event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length) {
                event.preventDefault();
                onPasteImages?.(files);
              }
            }}
            placeholder={placeholder}
            ref={inputRef}
            rows={1}
            value={value}
          />
        )}
      </div>
      <div className="conversation-composer-footer">
        <div className="conversation-composer-leading">
          {leadingAction}
          {showAttachmentButton && (
            <button
              aria-label="添加附件"
              className="conversation-composer-icon-button conversation-composer-add"
              disabled={disabled || !onAddAttachment}
              onClick={onAddAttachment}
              type="button"
            >
              <Plus aria-hidden="true" size={ICON_SM} />
            </button>
          )}
        </div>
        <div className="conversation-composer-actions">
          {streaming ? (
            <button
              aria-label={streamingStopLabel}
              className="conversation-composer-icon-button conversation-composer-stop"
              onClick={onStop}
              type="button"
            >
              <span aria-hidden="true" className="conversation-composer-stop-glyph" />
            </button>
          ) : (
            <button
              aria-label="发送消息"
              className="conversation-composer-icon-button conversation-composer-submit"
              disabled={disabled || submitDisabled}
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
