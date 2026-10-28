import { ArrowUp, Languages, Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import {
  applyControlledTextCommandAtSelection,
  replaceTextRange,
} from "../../ime/adapters/controlledTextAdapter";
import type { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
import { handleImeEditorKeyDown, imeEditorAttributes } from "../../ime/imeEditorBinding";
import type { ImeEditorCommand } from "../../ime/imeKeyRouter";
import { resolveImeEditorInputState } from "../../ime/imeTextPolicy";
import { ICON_SM } from "../../tokens";
import { ImeCandidateAnchorReporter } from "./ImeCandidateAnchorReporter";
import "./ConversationComposer.css";
import type { ImeKeyboardInput } from "@answra/shared";

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
  > &
    Partial<
      Pick<ReturnType<typeof useEmbeddedIme>, "sendNativeKey" | "setNativeKeyHandler">
    >;
  composition: Pick<
    ReturnType<typeof useControlledImeTextAdapter>,
    | "compositionRange"
    | "captureCompositionStart"
    | "cancelComposition"
    | "selection"
    | "setSelection"
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
  streamingStopLabel?: string;
  children?: ReactNode;
  leadingAction?: ReactNode;
  liveContent?: ReactNode;
  showAttachmentButton?: boolean;
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
  /** 是否渲染内置输入法开关。窄面板（如回复条弹层）不需要，避免只开关内置 IME、却不反映中英模式的误导控件。 */
  showImeToggle?: boolean;
  /** 隐身窗口不可激活，但 DOM 编辑器仍需要绘制逻辑光标。 */
  nonActivating?: boolean;
}

// textarea 不会随内容自动长高：高度锁在 CSS min-height 时第二行会被裁掉。
// 先复位到 auto 再按 scrollHeight 撑开（可缩可放），上限交给 CSS max-height。
// 高度不变时不写回，避免 ResizeObserver 观察自身高度造成反复触发。
function syncComposerHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const desired = `${textarea.scrollHeight}px`;
  if (textarea.style.height !== desired) textarea.style.height = desired;
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
  ime,
  showImeToggle = true,
  nonActivating = false,
}: ConversationComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies(value): 高度跟随内容增长，value 变化即重算
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    syncComposerHeight(textarea);
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const observer = new ResizeObserver(() => syncComposerHeight(textarea));
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

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

  const applyEditorCommand = useCallback((command: ImeEditorCommand) => {
    if (!ime) return;
    const edit = applyControlledTextCommandAtSelection(
      valueRef.current,
      ime.composition.selection,
      command,
      true,
    );
    ime.composition.setSelection(edit.selection);
    onValueChangeRef.current?.(edit.value);
  }, [ime]);

  useEffect(() => {
    if (!ime?.session.sendNativeKey || !ime.session.setNativeKeyHandler) return;
    const handleNativeKey = (input: ImeKeyboardInput) => {
      const handled = ime.session.sendNativeKey?.(
        input,
        applyEditorCommand,
        () =>
          ime.composition.captureCompositionStart(
            ime.composition.selection,
            ime.session.state.composing,
          ),
      );
      if (
        !handled &&
        input.type === "keydown" &&
        input.key === "Enter" &&
        !input.shift &&
        !input.ctrl &&
        !input.alt &&
        !input.meta
      ) {
        onSubmit?.();
      }
    };
    ime.session.setNativeKeyHandler(handleNativeKey);
    return () => ime.session.setNativeKeyHandler?.(undefined);
  }, [applyEditorCommand, ime, onSubmit]);

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
          showCaretWithoutFocus={nonActivating}
          state={ime.session.state}
          targetId={ime.session.targetId}
        />
      )}
      <div
        className={`conversation-composer-editor${ime?.session.state.composing ? " is-composing" : ""}`}
      >
        {liveContent ?? (
          <textarea
            {...imeAttributes}
            aria-label={inputLabel}
            aria-readonly={imeInputState.ariaReadOnly}
            className={ime ? "embedded-ime-input" : undefined}
            data-ime-native-input-blocked={
              imeInputState.nativeInputBlockedByIme ? "true" : undefined
            }
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
              const files = Array.from(event.clipboardData.files).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (files.length) {
                event.preventDefault();
                onPasteImages?.(files);
                return;
              }
              if (ime?.session.textPolicy.blockNativeEditing) {
                event.preventDefault();
                if (disabled) return;
                const text = event.clipboardData.getData("text/plain");
                if (!text) return;
                const edit = replaceTextRange(
                  valueRef.current,
                  ime?.composition.selection ?? { start: 0, end: 0 },
                  text,
                );
                ime?.composition.setSelection(edit.selection);
                onValueChangeRef.current?.(edit.value);
              }
            }}
            onKeyDown={(event) => {
              if (
                ime &&
                handleImeEditorKeyDown({
                  event,
                  policy: ime.session.textPolicy,
                  readSelection: () => ime.composition.selection,
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
            onSelect={(event) => {
              ime?.composition.setSelection({
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              });
            }}
            onFocus={nonActivating ? undefined : () => ime?.session.acquire()}
            onPointerDown={(event) => {
              if (nonActivating) event.preventDefault();
              ime?.session.acquire();
            }}
            onBlur={nonActivating ? undefined : () => ime?.session.blur()}
            tabIndex={nonActivating ? -1 : undefined}
            placeholder={placeholder}
            ref={textareaRef}
            rows={1}
            value={value}
          />
        )}
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
          {leadingAction}
          {ime && showImeToggle && (
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
          {showAttachmentButton && (
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
          )}
        </div>
        <div className="conversation-composer-actions">
          {streaming ? (
            <button
              aria-label={streamingStopLabel}
              className="conversation-composer-icon-button conversation-composer-stop"
              onClick={onStop}
              title={streamingStopLabel}
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
