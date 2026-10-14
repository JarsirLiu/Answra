import type { ImeState } from "@answra/shared";
import { ArrowUp, Languages, Plus } from "lucide-react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { ICON_SM } from "../../tokens";
import { ImeCandidatePopup } from "./ImeCandidatePopup";
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
  onAddAttachment,
  onSubmit,
  onStop,
  ime,
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
      {ime && (
        <ImeCandidatePopup onNavigate={ime.onNavigate} onSelect={ime.onSelect} state={ime.state} />
      )}
      <textarea
        aria-label={inputLabel}
        className={ime ? "embedded-ime-input" : undefined}
        data-embedded-ime-target={ime ? "true" : undefined}
        data-embedded-ime-active={ime?.active ? "true" : undefined}
        // Keep the control focusable while librime is starting. A disabled
        // textarea cannot receive the focus event needed to activate it.
        disabled={disabled}
        // While Rime owns keystrokes, Chromium must not start a native IME
        // composition in this editable control. readOnly preserves focus and
        // keydown delivery while preventing OS composition text insertion.
        // Keep the control read-only until the native helper is confirmed
        // ready; otherwise the operating system IME can take over startup.
        readOnly={disabled || Boolean(ime)}
        onChange={(event) => {
          if (ime) {
            console.warn("[ime-ui] unexpected native text input blocked");
            return;
          }
          onValueChange?.(event.target.value);
        }}
        onCompositionStart={(event) => {
          if (!ime?.imeEnabled) return;
          console.warn("[ime-ui] unexpected native composition blocked");
          event.preventDefault();
        }}
        onBeforeInput={(event) => {
          if (!ime?.imeEnabled) return;
          event.preventDefault();
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
          if (ime?.onKeyDown(event)) {
            event.preventDefault();
            return;
          }
          if (ime?.active && event.key === "Backspace") {
            event.preventDefault();
            onValueChange?.(value.slice(0, Math.max(0, value.length - 1)));
            return;
          }
          if (disabled || event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        onFocus={() => console.info("[ime-ui] composer focus", { label: inputLabel })}
        onBlur={() => console.info("[ime-ui] composer blur", { label: inputLabel })}
        placeholder={placeholder}
        ref={inputRef}
        rows={1}
        // 拼音 preedit 像原生输入法一样直接显示在输入框末尾（展示用，不进 draft）。
        value={value + (ime?.active ? ime.state.preedit : "")}
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
