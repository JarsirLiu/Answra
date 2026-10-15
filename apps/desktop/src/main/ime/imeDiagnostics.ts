const SUPPRESSED_EVENTS = new Set([
  "main-window-created",
  "main-window-always-on-top",
  "main-window-ready-to-show",
  "main-window-shown",
  "candidate-window-created",
  "candidate-renderer-page-loaded",
  "candidate-renderer-ready-request",
  "renderer-input-focus",
  "renderer-acquire-start",
  "renderer-acquire-result",
  "renderer-confirm-focus-start",
  "renderer-confirm-focus-result",
  "renderer-input-blur",
  "renderer-window-focus",
  "renderer-window-blur",
  "candidate-state-received",
  "candidate-state-sent",
  "candidate-update-show",
  "candidate-window-hidden",
  "renderer-key-routing",
  "renderer-document-keydown",
]);
const compositionByLease = new Map<string, boolean>();

/** Emits compact, single-line IME diagnostics to the pnpm dev main-process terminal. */
export function logImeDiagnostic(event: string, details: Record<string, unknown> = {}): void {
  if (event === "lease-released")
    compositionByLease.delete(`${details.windowId}:${details.generation}`);
  if (SUPPRESSED_EVENTS.has(event)) return;
  if (
    event === "candidate-position-status" &&
    ["already-visible", "show-request-visible"].includes(String(details.status))
  )
    return;
  if (event === "candidate-native-hide-requested") return;
  if (event === "candidate-native-hide-result" && details.wasVisible !== true) return;
  if (event === "candidate-native-positioned" && details.visible !== true) return;

  if (event === "key-processed") {
    const key = String(details.key ?? "");
    const lease = `${details.windowId}:${details.generation}`;
    const previousComposing = compositionByLease.get(lease) ?? false;
    const composing = details.composing === true;
    compositionByLease.set(lease, composing);
    if (compositionByLease.size > 32)
      compositionByLease.delete(compositionByLease.keys().next().value ?? "");
    const modifierKey = ["Control", "Shift", "Alt", "Meta"].includes(key);
    const hasModifier = details.ctrl === true || details.alt === true || details.meta === true;
    const meaningful =
      !modifierKey &&
      (!details.handled ||
        hasModifier ||
        composing !== previousComposing ||
        Boolean(details.committedText));
    if (!meaningful) return;
    const candidates = Array.isArray(details.candidates)
      ? details.candidates
          .map((candidate) =>
            typeof candidate === "object" && candidate !== null && "text" in candidate
              ? String(candidate.text)
              : "",
          )
          .filter(Boolean)
          .join(" | ")
      : "";
    console.info(
      `[ime] key ${json({
        generation: details.generation,
        key,
        ctrl: details.ctrl,
        alt: details.alt,
        meta: details.meta,
        handled: details.handled,
        composing: details.composing,
        preedit: details.preedit,
        committedText: details.committedText,
        candidates,
        selectedIndex: details.selectedIndex,
      })}`,
    );
    return;
  }

  if (event === "key-routing") {
    console.info(
      `[ime] key-routing ${json({
        generation: details.generation,
        key: details.key,
        keyCode: details.keyCode,
        keyKind: details.keyKind,
        ctrl: details.ctrl,
        alt: details.alt,
        meta: details.meta,
        composing: details.composing,
        imeConsumed: details.accepted,
        activeElementTarget: details.activeElementTarget,
        focusedRef: details.focusedRef,
        selectionStart: details.selectionStart,
        selectionEnd: details.selectionEnd,
        selectionLength: details.selectionLength,
        valueLength: details.valueLength,
      })}`,
    );
    return;
  }

  if (event === "candidate-rendered") {
    const root = record(details.candidateRoot);
    const popup = record(details.candidatePopup);
    const rootRect = record(root?.rect);
    const popupRect = record(popup?.rect);
    const rootStyle = root
      ? { display: root.display, visibility: root.visibility, opacity: root.opacity }
      : undefined;
    const popupStyle = popup
      ? { display: popup.display, visibility: popup.visibility, opacity: popup.opacity }
      : undefined;
    const presentation = json({
      generation: details.generation,
      visibility: details.documentVisibility,
      documentHasFocus: details.documentHasFocus,
      root: rootRect,
      popup: popupRect,
      rootStyle,
      popupStyle,
    });
    if (presentation === lastCandidatePresentation) return;
    lastCandidatePresentation = presentation;
    const candidates = Array.isArray(details.candidates)
      ? details.candidates
          .map((candidate) =>
            typeof candidate === "object" && candidate !== null && "text" in candidate
              ? String(candidate.text)
              : "",
          )
          .filter(Boolean)
          .join(" | ")
      : "";
    console.info(
      `[ime] candidate-ui rendered ${json({
        generation: details.generation,
        preedit: details.preedit,
        candidates,
        selectedIndex: details.selectedIndex,
        page: details.page,
        visibility: details.documentVisibility,
        documentHasFocus: details.documentHasFocus,
        root: rootRect,
        popup: popupRect,
        rootStyle,
        popupStyle,
      })}`,
    );
    return;
  }

  if (event.startsWith("candidate-native-")) {
    const display = record(details.display);
    const protection = record(details.captureProtection);
    console.info(
      `[ime] candidate-window ${event.slice("candidate-native-".length)} ${json({
        windowId: details.windowId,
        ownerWindowId: details.ownerWindowId,
        targetId: details.targetId,
        generation: details.generation,
        nativeHandle: details.nativeHandle,
        bounds: details.bounds,
        anchor: details.anchor,
        ownerContentBounds: details.ownerContentBounds,
        visible: details.visible,
        minimized: details.minimized,
        focused: details.focused,
        focusedWindowId: details.focusedWindowId,
        alwaysOnTop: details.alwaysOnTop,
        focusable: details.focusable,
        ownerVisible: details.ownerVisible,
        ownerFocused: details.ownerFocused,
        appForeground: details.appForeground,
        protected: protection?.reportedProtected ?? "unknown",
        displayId: display?.id,
        scaleFactor: display?.scaleFactor,
        reason: details.reason,
      })}`,
    );
    return;
  }

  console.info(`[ime] ${event} ${json(details)}`);
}

let lastCandidatePresentation: string | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}
