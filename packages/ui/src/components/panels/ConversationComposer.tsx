import type { ImeCandidateUpdate, ImeState } from "@answra/shared";
import { ArrowUp, Languages, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import type { TextSelectionRange } from "../../ime/adapters/controlledTextAdapter";
import { applyControlledTextCommand } from "../../ime/adapters/controlledTextAdapter";
import type { ImeEditorCommand } from "../../ime/imeKeyRouter";
import type { ImeTextPolicy } from "../../ime/imeTextPolicy";
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
    textPolicy: ImeTextPolicy;
    shouldPreventBeforeInput: (inputType: string) => boolean;
    state: ImeState;
    onKeyDown: (
      event: React.KeyboardEvent<HTMLTextAreaElement>,
      applyEditorCommand: (command: ImeEditorCommand) => void,
    ) => boolean;
    onKeyUp?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
    onSelect: (index: number) => void;
    onNavigate: (key: string) => void;
    onCandidateUpdate: (payload: ImeCandidateUpdate) => void;
    onTextStart?: (range: TextSelectionRange) => void;
    compositionRange?: TextSelectionRange | null;
    onFocus: () => void;
    onBlur: () => void;
    targetId: string;
    generation?: number;
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
  const pendingCaret = useRef<number | null>(null);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  valueRef.current = value;
  onValueChangeRef.current = onValueChange;

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
    }
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled && !submitDisabled) onSubmit?.();
  }

  function applyEditorCommand(command: ImeEditorCommand) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const edit = applyControlledTextCommand(textarea, valueRef.current, command);
    if (!edit) return;
    pendingCaret.current = edit.caret;
    onValueChangeRef.current?.(edit.value);
  }

  return (
    <form
      className={`conversation-composer input-surface${compact ? " is-compact" : ""}${disabled ? " is-readonly" : ""}`}
      onSubmit={handleSubmit}
    >
      {children}
      {ime && (
        <ImeCandidateAnchorReporter
          generation={ime.generation}
          onUpdate={ime.onCandidateUpdate}
          state={ime.state}
          targetId={ime.targetId}
        />
      )}
      <div className={`conversation-composer-editor${ime?.state.composing ? " is-composing" : ""}`}>
        <textarea
          aria-label={inputLabel}
          className={ime ? "embedded-ime-input" : undefined}
          data-embedded-ime-target={ime ? "true" : undefined}
          data-embedded-ime-active={ime?.active ? "true" : undefined}
          data-ime-composition-active={ime?.state.composing ? "true" : undefined}
          data-ime-policy={ime ? "text" : "excluded"}
          data-ime-target-id={ime?.targetId}
          disabled={disabled}
          readOnly={disabled || Boolean(ime?.textPolicy.blockNativeEditing)}
          onChange={(event) => {
            if (ime && !ime.textPolicy.useNativeTextInput) return;
            onValueChange?.(event.target.value);
          }}
          onCompositionStart={(event) => {
            if (ime?.textPolicy.blockComposition) event.preventDefault();
          }}
          onBeforeInput={(event) => {
            const inputType = event.nativeEvent.inputType;
            if (ime?.shouldPreventBeforeInput(inputType)) event.preventDefault();
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
            if (
              ime?.textPolicy.captureCompositionStart &&
              (event.key.length === 1 || event.key === "Process") &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey
            ) {
              const range = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
              ime.onTextStart?.(range);
            }
            if (ime?.onKeyDown(event, applyEditorCommand)) {
              event.preventDefault();
              return;
            }
            if (disabled || event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          onKeyUp={(event) => {
            if (ime?.onKeyUp?.(event)) event.preventDefault();
          }}
          onFocus={() => {
            ime?.onFocus();
          }}
          onBlur={() => {
            ime?.onBlur();
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={value}
        />
        {ime?.state.composing && ime.state.preedit && ime.compositionRange && (
          <ControlledTextCompositionMirror
            inputRef={textareaRef}
            preedit={ime.state.preedit}
            range={ime.compositionRange}
            targetId={ime.targetId}
            value={value}
          />
        )}
      </div>
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
