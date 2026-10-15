import {
  type ImeCandidateAction,
  ImeCandidateChannels,
  type ImeCandidateUpdate,
} from "@answra/shared";
import { BrowserWindow, ipcMain } from "electron";
import {
  getReplyBarWindow,
  getWindow,
  isImeCandidateWindowFromSender,
  isWindowFromSender,
  resizeImeCandidateWindow,
  sendImeCandidateAction,
  sendImeCandidateState,
  setImeCandidateState,
} from "../window";

export function registerImeCandidateIpc(
  isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) => boolean,
): void {
  ipcMain.on(ImeCandidateChannels.Update, (event, payload: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !isOwnerWindow(owner, event)) return;
    if (
      !isCandidateUpdate(payload) ||
      !payload.targetId ||
      payload.generation === undefined ||
      !isCurrentLease(owner, payload.targetId, payload.generation)
    )
      return;
    setImeCandidateState(owner, payload);
  });

  ipcMain.on(ImeCandidateChannels.Fit, (event, size: unknown) => {
    if (!isImeCandidateWindowFromSender(event) || !isValidSize(size)) return;
    resizeImeCandidateWindow(size);
  });

  ipcMain.on(ImeCandidateChannels.Ready, (event) => {
    if (isImeCandidateWindowFromSender(event)) sendImeCandidateState();
  });

  ipcMain.on(ImeCandidateChannels.Action, (event, action: unknown) => {
    if (
      !isImeCandidateWindowFromSender(event) ||
      !isCandidateAction(action) ||
      !isCurrentLeaseForAction(action)
    )
      return;
    sendImeCandidateAction(action);
  });

  function isCurrentLeaseForAction(action: ImeCandidateAction): boolean {
    const candidateOwner = getWindow();
    if (candidateOwner && isCurrentLease(candidateOwner, action.targetId, action.generation))
      return true;
    const replyOwner = getReplyBarWindow();
    return !!replyOwner && isCurrentLease(replyOwner, action.targetId, action.generation);
  }
}

function isOwnerWindow(owner: BrowserWindow, event: Electron.IpcMainEvent): boolean {
  const main = getWindow();
  if (main && owner === main && isWindowFromSender(main, event)) return true;
  const reply = getReplyBarWindow();
  return !!reply && owner === reply && isWindowFromSender(reply, event);
}

function isCandidateUpdate(value: unknown): value is ImeCandidateUpdate {
  if (!isRecord(value)) return false;
  if (value.type === "suspend" || value.type === "clear")
    return (
      typeof value.targetId === "string" &&
      Number.isInteger(value.generation) &&
      (value.state === undefined || isImeState(value.state))
    );
  if (value.type !== "show") return false;
  const payload = value as {
    state?: unknown;
    anchor?: unknown;
    targetId?: unknown;
    generation?: unknown;
  };
  if (!isImeState(payload.state) || !isRecord(payload.anchor)) return false;
  const anchor = payload.anchor;
  return (
    Number.isFinite(anchor.x) &&
    Number.isFinite(anchor.lineTop) &&
    Number.isFinite(anchor.lineBottom) &&
    typeof payload.targetId === "string" &&
    Number.isInteger(payload.generation)
  );
}

function isImeState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const state = value;
  return (
    typeof state.enabled === "boolean" &&
    typeof state.composing === "boolean" &&
    typeof state.preedit === "string" &&
    Array.isArray(state.candidates) &&
    state.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.text === "string" &&
        (candidate.comment === undefined || typeof candidate.comment === "string"),
    ) &&
    Number.isInteger(state.selectedIndex) &&
    Number.isInteger(state.page) &&
    typeof state.hasNextPage === "boolean"
  );
}

function isCandidateAction(value: unknown): value is ImeCandidateAction {
  if (!isRecord(value)) return false;
  if (typeof value.targetId !== "string" || !Number.isInteger(value.generation)) return false;
  if (value.type === "select") return Number.isInteger(value.index) && (value.index as number) >= 0;
  return value.type === "navigate" && ["PageUp", "PageDown"].includes(String(value.key));
}

function isValidSize(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
