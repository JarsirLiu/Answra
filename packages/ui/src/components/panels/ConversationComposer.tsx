import { ArrowUp, Languages, Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import { applyControlledTextCommand } from "../../ime/adapters/controlledTextAdapter";
import type { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
import { handleImeEditorKeyDown, imeEditorAttributes } from "../../ime/imeEditorBinding";
import type { ImeEditorCommand } from "../../ime/imeKeyRouter";
import { resolveImeEditorInputState } from "../../ime/imeTextPolicy";
import { ICON_SM } from "../../tokens";
import { ImeCandidateAnchorReporter } from "./ImeCandidateAnchorReporter";
import "./ConversationComposer.css";

/** The embedded-IME session and composition adapter, consumed as their single writers. */
export interface ConversationComposerIme {
  session: Pick<
    ReturnType<typeof useEmbeddedIme>,
    | "available"
    | "active"
    | "imeEnabled"
    | "generation"
    | "state"
    | "textPolicy"
    | "targetId"
    | "shouldPreventBeforeInput"
    | "sendKey"
    | "sendKeyUp"
    | "updateCandidate"
    | "acquire"
    | "blur"
    | "toggle"
  >;
  composition: Pick<
    ReturnType<typeof useControlledImeTextAdapter>,
    "compositionRange" | "captureCompositionStart" | "cancelComposition"
  >;
}

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
  /** 嵌入式输入法会话与 composition 适配器，直接传入 `useEmbeddedIme`/`useControlledImeTextAdapter` 的返回。 */
  ime?: ConversationComposerIme;
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

  // The preedit mirror only makes sense while the engine is composing: drop the captured
  // range as soon as the session reports the composition ended.
  const composing = ime?.session.state.composing ?? false;
  const cancelComposition = ime?.composition.cancelComposition;
  useEffect(() => {
    if (!composing) cancelComposition?.();
  }, [cancelComposition, composing]);

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

  const imeAttributes = ime
    ? imeEditorAttributes({
        active: ime.session.active,
        composing: ime.session.state.composing,
        targetId: ime.session.targetId,
      })
    : { "data-ime-policy": "excluded" };
  const imeInputState = ime
    ? resolveImeEditorInputState({
        businessReadOnly: disabled,
        policy: ime.session.textPolicy,
      })
    : { readOnly: disabled, ariaReadOnly: disabled || undefined, nativeInputBlockedByIme: false };

  return (
    <form
      className={`conversation-composer input-surface${compact ? " is-compact" : ""}${disabled ? " is-readonly" : ""}`}
      onSubmit={handleSubmit}
    >
      {children}
      {ime && (
        <ImeCandidateAnchorReporter
          blockNativeEditing={ime.session.textPolicy.blockNativeEditing}
          generation={ime.session.generation}
          onUpdate={ime.session.updateCandidate}
          state={ime.session.state}
          targetId={ime.session.targetId}
        />
      )}
      <div
        className={`conversation-composer-editor${ime?.session.state.composing ? " is-composing" : ""}`}
      >
        <textarea
          {...imeAttributes}
          aria-label={inputLabel}
          aria-readonly={imeInputState.ariaReadOnly}
          className={ime ? "embedded-ime-input" : undefined}
          data-ime-native-input-blocked={imeInputState.nativeInputBlockedByIme ? "true" : undefined}
          disabled={disabled}
          readOnly={imeInputState.readOnly}
          onChange={(event) => {
            if (ime && !ime.session.textPolicy.useNativeTextInput) return;
            onValueChange?.(event.target.value);
          }}
          onCompositionStart={(event) => {
            if (ime?.session.textPolicy.blockComposition) event.preventDefault();
          }}
          onBeforeInput={(event) => {
            const inputType = event.nativeEvent.inputType;
            if (ime?.session.shouldPreventBeforeInput(inputType)) event.preventDefault();
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
              ime &&
              handleImeEditorKeyDown({
                event,
                policy: ime.session.textPolicy,
                readSelection: () => ({
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                }),
                onCaptureCompositionStart: (range) =>
                  ime.composition.captureCompositionStart(range, ime.session.state.composing),
                sendKey: (keyEvent, apply) => ime.session.sendKey(keyEvent, false, apply),
                applyEditorCommand,
              })
            ) {
              event.preventDefault();
              return;
            }
            if (disabled || event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          onKeyUp={(event) => {
            if (ime?.session.sendKeyUp(event)) event.preventDefault();
          }}
          onFocus={() => {
            ime?.session.acquire();
          }}
          onBlur={() => {
            ime?.session.blur();
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={value}
        />
        {ime?.session.state.composing &&
          ime.session.state.preedit &&
          ime.composition.compositionRange && (
            <ControlledTextCompositionMirror
              inputRef={textareaRef}
              preedit={ime.session.state.preedit}
              range={ime.composition.compositionRange}
              targetId={ime.session.targetId}
              value={value}
            />
          )}
      </div>
      <div className="conversation-composer-footer">
        <div className="conversation-composer-leading">
          {ime && (
            <button
              aria-label={ime.session.imeEnabled ? "关闭内置输入法" : "启用内置输入法"}
              aria-pressed={ime.session.active}
              className={`conversation-composer-icon-button conversation-composer-ime${ime.session.active ? " is-active" : ""}`}
              disabled={!ime.session.available || disabled}
              onClick={ime.session.toggle}
              title={ime.session.active ? "关闭内置输入法" : "启用内置输入法"}
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
