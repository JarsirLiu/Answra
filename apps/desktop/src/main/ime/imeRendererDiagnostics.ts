/** Validates renderer IME diagnostic ingress and projects approved fields into logs. */
import {
  IME_RENDERER_DIAGNOSTIC_EVENTS,
  type ImeRendererDiagnostic,
  type ImeRendererDiagnosticEvent,
} from "@answra/shared";
import type { IpcMainEvent } from "electron";

const DIAGNOSTIC_TARGET_IDS = new Set([
  "chat-composer",
  "reply-composer",
  "settings-base-url",
  "settings-model",
  "workspace-directory-filter",
  "workspace-markdown-editor",
  "main-composer",
]);

interface DiagnosticWindow {
  id: number;
  webContents: { id: number };
}

interface Dependencies {
  isCandidateWindowFromSender: (event: IpcMainEvent) => boolean;
  getCandidateWindow: (event: IpcMainEvent) => DiagnosticWindow | undefined;
  getOwnerWindow: (event: IpcMainEvent) => DiagnosticWindow | undefined;
  isDebugEnabled: () => boolean;
  log: (event: string, details: Record<string, unknown>) => void;
}

/** Returns the single renderer-diagnostic ingress handler used by the IME IPC root. */
export function createImeRendererDiagnosticHandler({
  isCandidateWindowFromSender,
  getCandidateWindow,
  getOwnerWindow,
  isDebugEnabled,
  log,
}: Dependencies): (event: IpcMainEvent, payload: unknown) => void {
  return (event, payload) => {
    if (isCandidateWindowFromSender(event)) {
      const candidateWindow = getCandidateWindow(event);
      if (!candidateWindow || !isCandidateRendererDiagnostic(payload)) return;
      if (payload.event === "candidate-rendered")
        log(payload.event, {
          windowId: candidateWindow.id,
          webContentsId: event.sender.id,
          targetId: payload.targetId,
          ownerTargetId: payload.ownerTargetId,
          generation: payload.generation,
          revision: payload.revision,
          preedit: payload.preedit,
          candidates: payload.candidates,
          selectedIndex: payload.selectedIndex,
          page: payload.page,
          documentVisibility: payload.documentVisibility,
          documentHasFocus: payload.documentHasFocus,
          candidateRoot: payload.candidateRoot,
          candidatePopup: payload.candidatePopup,
        });
      return;
    }

    const window = getOwnerWindow(event);
    if (!window || !isImeRendererDiagnostic(payload)) return;
    const details = projectRendererDiagnostic(window, event.sender.id, payload);
    if (payload.event === "document-keydown" || payload.event === "input-mounted") {
      if (isDebugEnabled()) log(`renderer-${payload.event}`, details);
    } else if (
      payload.event === "key-routing" &&
      !isDebugEnabled() &&
      !(payload.ctrl || payload.alt || payload.meta || payload.keyKind === "backspace")
    ) {
      return;
    } else if (payload.event === "key-routing") {
      log("key-routing", details);
    } else {
      log(`renderer-${payload.event}`, details);
    }
  };
}

function projectRendererDiagnostic(
  window: DiagnosticWindow,
  webContentsId: number,
  payload: ImeRendererDiagnostic,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    windowId: window.id,
    webContentsId,
    targetId: payload.targetId,
  };
  if (payload.source === "input-focus" || payload.source === "window-focus")
    details.source = payload.source;
  if (Number.isInteger(payload.generation)) details.generation = payload.generation;
  if (typeof payload.key === "string") details.key = payload.key;
  if (typeof payload.preedit === "string") details.preedit = payload.preedit;
  if (typeof payload.committedText === "string") details.committedText = payload.committedText;
  if (Array.isArray(payload.candidates)) details.candidates = payload.candidates;
  for (const key of ["selectionStart", "selectionEnd", "selectionLength", "valueLength"] as const) {
    const value = payload[key];
    if (Number.isInteger(value)) details[key] = value;
  }
  for (const key of [
    "activeElementTarget",
    "documentHasFocus",
    "targetRegistered",
    "imeAvailable",
    "imeEnabled",
    "composing",
    "accepted",
    "repeat",
    "ctrl",
    "alt",
    "meta",
  ] as const) {
    const value = payload[key];
    if (typeof value === "boolean") details[key] = value;
  }
  if (typeof payload.keyCode === "string" && /^[a-z0-9]{1,24}$/i.test(payload.keyCode))
    details.keyCode = payload.keyCode;
  if (typeof payload.reason === "string" && /^[a-z-]{1,40}$/.test(payload.reason))
    details.reason = payload.reason;
  if (
    ["text", "process", "backspace", "enter", "navigation", "other"].includes(payload.keyKind ?? "")
  )
    details.keyKind = payload.keyKind;
  return details;
}

function isImeRendererDiagnostic(value: unknown): value is ImeRendererDiagnostic {
  if (
    !isRecord(value) ||
    typeof value.targetId !== "string" ||
    !DIAGNOSTIC_TARGET_IDS.has(value.targetId)
  )
    return false;
  return (
    value.event !== "candidate-rendered" &&
    IME_RENDERER_DIAGNOSTIC_EVENTS.includes(value.event as ImeRendererDiagnosticEvent)
  );
}

function isCandidateRendererDiagnostic(value: unknown): value is ImeRendererDiagnostic {
  if (!isRecord(value) || value.targetId !== "ime-candidate-window") return false;
  if (!Number.isInteger(value.generation) || typeof value.ownerTargetId !== "string") return false;
  if (value.event !== "candidate-rendered") return false;
  if (value.preedit !== undefined && typeof value.preedit !== "string") return false;
  if (
    value.revision !== undefined &&
    (typeof value.revision !== "number" ||
      !Number.isInteger(value.revision) ||
      value.revision < 0)
  )
    return false;
  if (
    value.candidates !== undefined &&
    (!Array.isArray(value.candidates) ||
      !value.candidates.every(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate.text === "string" &&
          (candidate.comment === undefined || typeof candidate.comment === "string"),
      ))
  )
    return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
