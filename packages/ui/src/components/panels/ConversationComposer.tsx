import type { ImeCandidateUpdate, ImeState } from "@answra/shared";
import { ArrowUp, Languages, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { ICON_SM } from "../../tokens";
import { ImeCandidateAnchorReporter } from "./ImeCandidateAnchorReporter";
import "./ConversationComposer.css";

interface ConversationComposerProps {
  value: string;
  placeholder: string;
  inputLabel: string;
  submitDisabled?: boolean;
  disabled?: boolean;
  /** 紧凑变体：弹窗等窄面板里缩小内边距与控件尺寸，把空间让给消息区。 */
  compact?: boolean;
  /** 流式进行中：发送按钮切换为停止按钮。 */
  streaming?: boolean;
  children?: ReactNode;
  /** 外部持有输入框引用（如消息操作条的"引用回复"聚焦）。 */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onValueChange?: (value: string) => void;
  /** 粘贴图片文件（走宿主附件通道，不内联进文本）。 */
  onPasteImages?: (files: File[]) => void;
  onAddAttachment?: () => void;
  onSubmit?: () => void;
  /** 停止当前回复（streaming 时替换发送按钮）。 */
  onStop?: () => void;
  ime?: {
    available: boolean;
    active: boolean;
    imeEnabled: boolean;
    state: ImeState;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
    onSelect: (index: number) => void;
    onNavigate: (key: string) => void;
    onCandidateUpdate: (payload: ImeCandidateUpdate) => void;
    onToggle: () => void;
  };
}

export function ConversationComposer({
  value,
  placeholder,
  inputLabel,
  submitDisabled = false,
  disabled = false,
  compact = false,
  streaming = false,
  children,
  inputRef,
  onValueChange,
  onPasteImages,
  onAddAttachment,
  onSubmit,
  onStop,
  ime,
}: ConversationComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionStart = useRef(value.length);
  const previousPreeditLength = useRef(0);
  const pendingCaret = useRef<number | null>(null);
  const preedit = ime?.active ? ime.state.preedit : "";
  const displayValue = `${value.slice(0, compositionStart.current)}${preedit}${value.slice(compositionStart.current)}`;

  useLayoutEffect(() => {
    if (inputRef) inputRef.current = textareaRef.current;
    return () => {
      if (inputRef?.current === textareaRef.current) inputRef.current = null;
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = pendingCaret.current;
    if (caret !== null) {
      textarea.setSelectionRange(caret, caret);
      pendingCaret.current = null;
      compositionStart.current = caret;
      return;
    }
    if (preedit) {
      if (document.activeElement !== textarea) textarea.focus({ preventScroll: true });
      const caretAfterPreedit = compositionStart.current + preedit.length;
      textarea.setSelectionRange(caretAfterPreedit, caretAfterPreedit);
      previousPreeditLength.current = preedit.length;
      return;
    }
    if (previousPreeditLength.current > 0) {
      textarea.setSelectionRange(compositionStart.current, compositionStart.current);
      previousPreeditLength.current = 0;
    }
  });

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
      {ime && <ImeCandidateAnchorReporter onUpdate={ime.onCandidateUpdate} state={ime.state} />}
      <textarea
        aria-label={inputLabel}
        className={ime ? "embedded-ime-input" : undefined}
        data-embedded-ime-target={ime ? "true" : undefined}
        data-embedded-ime-active={ime?.active ? "true" : undefined}
        disabled={disabled}
        readOnly={disabled || Boolean(ime)}
        onChange={(event) => {
          if (ime) return;
          onValueChange?.(event.target.value);
        }}
        onCompositionStart={(event) => {
          if (!ime?.imeEnabled) return;
          event.preventDefault();
        }}
        onBeforeInput={(event) => {
          if (ime?.imeEnabled) event.preventDefault();
        }}
        onPaste={(event) => {
          if (ime) return;
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length) {
            event.preventDefault();
            onPasteImages?.(files);
          }
        }}
        onKeyDown={(event) => {
          if (ime) {
            console.info("[ime-ui] composer key", {
              key: event.key,
              code: event.code,
              available: ime.available,
              imeEnabled: ime.imeEnabled,
              active: ime.active,
              composing: ime.state.composing,
            });
          }
          if (
            ime?.active &&
            !ime.state.composing &&
            (event.key.length === 1 || event.key === "Process") &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            compositionStart.current = event.currentTarget.selectionStart;
          }
          if (ime?.onKeyDown(event)) {
            event.preventDefault();
            return;
          }
          if (ime?.active && event.key === "Backspace") {
            event.preventDefault();
            const { selectionStart, selectionEnd } = event.currentTarget;
            const start =
              selectionStart === selectionEnd ? Math.max(0, selectionStart - 1) : selectionStart;
            const next = value.slice(0, start) + value.slice(selectionEnd);
            pendingCaret.current = start;
            onValueChange?.(next);
            return;
          }
          if (disabled || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        onFocus={() => console.info("[ime-ui] composer focus", { label: inputLabel })}
        onBlur={() => console.info("[ime-ui] composer blur", { label: inputLabel })}
        placeholder={placeholder}
        ref={textareaRef}
        rows={1}
        value={displayValue}
      />
      <div className="conversation-composer-footer">
        <div className="conversation-composer-leading">
          {ime && (
            <button
              aria-label={ime.imeEnabled ? "关闭内置输入法" : "启用内置输入法"}
              aria-pressed={ime.active}
              className={`conversation-composer-icon-button conversation-composer-ime${ime.active ? " is-active" : ""}`}
              disabled={!ime.available || disabled}
              onClick={ime.onToggle}
              title={ime.active ? "关闭内置输入法" : "启用内置输入法"}
              type="button"
            >
              <Languages aria-hidden="true" size={ICON_SM} />
            </button>
          )}
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
