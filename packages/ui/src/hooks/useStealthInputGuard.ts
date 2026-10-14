import { useEffect } from "react";

/**
 * Prevents system text-input surfaces while meeting stealth is enabled.
 *
 * IME candidate and suggestion windows are owned by the operating system, not
 * by Answra's protected BrowserWindow. Blocking focus before composition starts
 * avoids exposing partially typed text on both Windows and macOS. File inputs
 * are blocked too: opening a native picker creates an unprotected system
 * surface while stealth is enabled. Buttons, sliders and selects remain usable.
 */
export function useStealthInputGuard(enabled: boolean): void {
  useEffect(() => {
    const onCompositionStart = (event: CompositionEvent) => {
      if (!isTextEntryTarget(event.target)) return;
      console.warn("[ime-ui] system composition blocked");
      event.preventDefault();
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!isTextEntryTarget(event.target)) return;
      if (!event.inputType.startsWith("insertComposition")) return;
      event.preventDefault();
    };

    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    if (!enabled) {
      return () => {
        document.removeEventListener("compositionstart", onCompositionStart, true);
        document.removeEventListener("beforeinput", onBeforeInput, true);
      };
    }

    const blurActiveElement = () => {
      const active = document.activeElement;
      if (isTextEntryTarget(active)) (active as HTMLElement).blur();
    };

    blurActiveElement();

    const onPointerDown = (event: PointerEvent) => {
      if (isEmbeddedImeTarget(event.target)) return;
      if (isEmbeddedImeCandidateTarget(event.target)) {
        event.preventDefault();
        (event.target as HTMLElement).dataset.imeFocusPending = "true";
        return;
      }
      if (!isTextEntryTarget(event.target)) return;
      event.preventDefault();
      (event.target as HTMLElement).blur();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isEmbeddedImeTarget(event.target)) return;
      if (isEmbeddedImeCandidateTarget(event.target)) {
        (event.target as HTMLElement).dataset.imeFocusPending = "true";
        (event.target as HTMLElement).blur();
        return;
      }
      if (!isTextEntryTarget(event.target)) return;
      event.preventDefault();
      (event.target as HTMLElement).blur();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEmbeddedImeTarget(event.target)) return;
      if (isTextEntryTarget(event.target)) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (isBlockedInputTarget(event.target)) event.preventDefault();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("compositionstart", onCompositionStart, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [enabled]);
}

function isEmbeddedImeTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.dataset.embeddedImeTarget === "true";
}

function isEmbeddedImeCandidateTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.dataset.embeddedImeTarget === "true";
}

function isTextEntryTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable='true']")) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
    "file",
  ].includes(target.type);
}

function isBlockedInputTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLInputElement)) return false;
  return target.type === "file" || isTextEntryTarget(target);
}
