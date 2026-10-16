import { useEffect } from "react";

/**
 * Prevents system text-input surfaces while meeting stealth is enabled.
 *
 * IME candidate and suggestion windows are owned by the operating system, not
 * by Answra's protected BrowserWindow. Blocking focus before composition starts
 * avoids exposing partially typed text on both Windows and macOS. File inputs
 * are blocked too: opening a native picker creates an unprotected system
 * surface while stealth is enabled. Buttons, sliders and selects remain usable.
 *
 * The guard is inert when stealth is disabled: registering the fail-closed
 * listeners unconditionally used to lock the app's own editors until reload.
 * Answra's embedded IME targets are never blurred, because they own the text
 * lifecycle through Rime and only need the platform composition cancelled.
 */
export function useStealthInputGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const reportedCompositionTargets = new WeakSet<HTMLElement>();
    const nativeCompositionFailureAttribute = "data-native-ime-isolation-failed";
    const hasNativeCompositionFailure = () =>
      document.documentElement.hasAttribute(nativeCompositionFailureAttribute);
    const onCompositionStart = (event: CompositionEvent) => {
      if (!isTextEntryTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isEmbeddedImeTarget(event.target)) return;
      document.documentElement.setAttribute(nativeCompositionFailureAttribute, "true");
      if (!reportedCompositionTargets.has(event.target)) {
        reportedCompositionTargets.add(event.target);
        console.error("[ime-ui] unexpected system composition; text input locked until reload");
      }
      event.target.blur();
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!isTextEntryTarget(event.target)) return;
      if (!event.inputType.startsWith("insertComposition")) return;
      event.preventDefault();
    };
    const lockTextAfterCompositionFailure = (event: Event) => {
      if (!hasNativeCompositionFailure() || !isTextEntryTarget(event.target)) return;
      if (isEmbeddedImeTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.blur();
    };

    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("pointerdown", lockTextAfterCompositionFailure, true);
    document.addEventListener("focusin", lockTextAfterCompositionFailure, true);
    document.addEventListener("keydown", lockTextAfterCompositionFailure, true);

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
      document.removeEventListener("pointerdown", lockTextAfterCompositionFailure, true);
      document.removeEventListener("focusin", lockTextAfterCompositionFailure, true);
      document.removeEventListener("keydown", lockTextAfterCompositionFailure, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [enabled]);
}

function isEmbeddedImeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("[data-embedded-ime-target]") !== null;
}

function isEmbeddedImeCandidateTarget(target: EventTarget | null): boolean {
  return isEmbeddedImeTarget(target);
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
