import {
  type ImeCandidateAction,
  ImeCandidateChannels,
  type ImeCandidateUpdate,
  type ImeSessionSnapshot,
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
import { logImeDiagnostic } from "./imeDiagnostics";

export function registerImeCandidateIpc(
  isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) => boolean,
  getSessionSnapshot: () => ImeSessionSnapshot,
): void {
  ipcMain.on(ImeCandidateChannels.Update, (event, payload: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !isOwnerWindow(owner, event)) {
      logImeDiagnostic("candidate-update-rejected", { reason: "owner-mismatch" });
      return;
    }
    if (!isCandidateUpdate(payload) || !payload.targetId || payload.generation === undefined) {
      logImeDiagnostic("candidate-update-rejected", { reason: "invalid-payload" });
      return;
    }
    if (!isCurrentLease(owner, payload.targetId, payload.generation)) {
      logImeDiagnostic("candidate-update-rejected", {
        reason: "stale-lease",
        targetId: payload.targetId,
        generation: payload.generation,
      });
      return;
    }
    if (payload.type === "suspend") {
      setImeCandidateState(owner, payload);
      return;
    }
    const snapshot = getSessionSnapshot();
    if (
      snapshot.phase !== "owned" ||
      snapshot.owner?.targetId !== payload.targetId ||
      snapshot.owner.generation !== payload.generation
    ) {
      logImeDiagnostic("candidate-update-rejected", {
        reason: "session-mismatch",
        targetId: payload.targetId,
        generation: payload.generation,
        phase: snapshot.phase,
        ownerTargetId: snapshot.owner?.targetId,
        ownerGeneration: snapshot.owner?.generation,
      });
      return;
    }
    setImeCandidateState(owner, payload, snapshot.engine);
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
  if (Object.hasOwn(value, "state")) return false;
  if (value.type === "suspend" || value.type === "clear")
    return typeof value.targetId === "string" && Number.isInteger(value.generation);
  if (value.type !== "show") return false;
  const payload = value as {
    anchor?: unknown;
    targetId?: unknown;
    generation?: unknown;
  };
  if (!isRecord(payload.anchor)) return false;
  const anchor = payload.anchor;
  return (
    Number.isFinite(anchor.x) &&
    Number.isFinite(anchor.lineTop) &&
    Number.isFinite(anchor.lineBottom) &&
    typeof payload.targetId === "string" &&
    Number.isInteger(payload.generation)
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
