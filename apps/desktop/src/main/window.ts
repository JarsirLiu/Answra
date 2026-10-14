import {
  type ContentSize,
  type ConversationChange,
  ConversationChannels,
  type ImeCandidateAction,
  type ImeCandidateAnchor,
  type ImeState,
  type RegionSelection,
  type ReplyBarAction,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, type BrowserWindow } from "electron";
import { createImeCandidateWindowController } from "./ime/imeCandidateWindowController";
import { createMainWindowController } from "./mainWindowController";
import { createReplyBarWindowController } from "./replyBarWindowController";
import { getWindowCaptureDiagnostics } from "./windowCaptureProtection";
import { createWindowStealthController, setNativeImeEnabled } from "./windowStealthController";

let windowController: ReturnType<typeof createMainWindowController>;
let stealthController: ReturnType<typeof createWindowStealthController>;
let replyBarController: ReturnType<typeof createReplyBarWindowController>;
let imeCandidateController: ReturnType<typeof createImeCandidateWindowController>;

function ensureControllers(): void {
  if (windowController) return;
  windowController = createMainWindowController({
    onNativeShow: () => stealthController?.refresh("native-show"),
    onNativeResize: () => stealthController?.refresh("native-resize"),
    onClosed: () => replyBarController?.close(),
  });
  replyBarController = createReplyBarWindowController({
    getMainWindow: () => windowController.getWindow(),
    isStealthEnabled: () => stealthController?.isEnabled() ?? false,
    logCaptureSurfaceState,
    sendReplyBarAction,
  });
  imeCandidateController = createImeCandidateWindowController({
    isOwnerWindow: (window) =>
      window === windowController.getWindow() || window === replyBarController.getWindow(),
    isStealthEnabled: () => stealthController?.isEnabled() ?? false,
  });
  stealthController = createWindowStealthController({
    getMainWindow: () => windowController.getWindow(),
    setReplyBarProtection: (enabled) => replyBarController.setCaptureProtection(enabled),
    setImeCandidateProtection: (enabled) => imeCandidateController.setCaptureProtection(enabled),
    setReplyBarInputMethod: () => {
      const replyBar = replyBarController.getWindow();
      if (replyBar) setNativeImeEnabled(replyBar, false);
    },
  });
}

export function clampToWorkArea(size: ContentSize): ContentSize {
  ensureControllers();
  return windowController.clampToWorkArea(size);
}
export function resizeWindowToContent(size: ContentSize): void {
  ensureControllers();
  windowController.resizeToContent(size);
}
export function getWindow(): BrowserWindow | undefined {
  ensureControllers();
  return windowController.getWindow();
}
export function getReplyBarWindow(): BrowserWindow | undefined {
  ensureControllers();
  return replyBarController.getWindow();
}
export function setImeCandidateState(
  owner: BrowserWindow,
  payload: { state: ImeState; anchor: ImeCandidateAnchor } | null,
): void {
  ensureControllers();
  imeCandidateController.update(owner, payload);
}
export function resizeImeCandidateWindow(size: ContentSize): void {
  ensureControllers();
  imeCandidateController.resize(size);
}
export function isImeCandidateWindowFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  ensureControllers();
  return imeCandidateController.isCandidateContents(event.sender);
}
export function sendImeCandidateState(): void {
  ensureControllers();
  imeCandidateController.markRendererReady();
}
export function sendImeCandidateAction(action: ImeCandidateAction): void {
  ensureControllers();
  imeCandidateController.routeAction(action);
}
export function disposeImeCandidateWindow(): void {
  if (!imeCandidateController) return;
  imeCandidateController.dispose();
}
export function sendConversationChange(change: ConversationChange): void {
  const mainWindow = getWindow();
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(ConversationChannels.Change, change);
  const replyWindow = getReplyBarWindow();
  if (
    conversationIdOf(change) === replyBarController.getConversationId() &&
    replyWindow &&
    !replyWindow.isDestroyed()
  )
    replyWindow.webContents.send(ConversationChannels.Change, change);
}
function conversationIdOf(change: ConversationChange): string {
  if (change.type === "event") return change.event.conversationId;
  return change.type === "snapshot" ? change.snapshot.conversationId : change.conversationId;
}
export function isStealthEnabled(): boolean {
  ensureControllers();
  return stealthController.isEnabled();
}
export { positionWindowNearSelection } from "./windowLayout";
export function setReplyBarAnchor(selection: RegionSelection): void {
  ensureControllers();
  replyBarController.setAnchor(selection);
}
export function setReplyBarWindowState(state: ReplyBarState | null): void {
  ensureControllers();
  replyBarController.setState(state);
}
export function isReplyBarWindowFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  ensureControllers();
  return replyBarController.isFromSender(event);
}
export function isReplyBarConversationId(conversationId: string): boolean {
  ensureControllers();
  return replyBarController.getConversationId() === conversationId;
}
export function hideReplyBarWindowForCapture(): boolean {
  ensureControllers();
  return replyBarController.hideForCapture();
}
export function restoreReplyBarWindowAfterCapture(wasVisible: boolean): void {
  ensureControllers();
  replyBarController.restoreAfterCapture(wasVisible);
}
export function resizeReplyBarWindow(size: ContentSize): void {
  ensureControllers();
  replyBarController.resize(size);
}
export function sendReplyBarAction(action: ReplyBarAction): void {
  const window = getWindow();
  if (window && !window.isDestroyed())
    window.webContents.send(WindowChannels.ReplyBarAction, action);
}
export function sendReplyBarState(): void {
  ensureControllers();
  replyBarController.sendState();
}
export function isWindowFromSender(
  window: BrowserWindow | undefined,
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  return event.sender === window?.webContents;
}
export function applyStealth(value: boolean): void {
  ensureControllers();
  stealthController.apply(value);
}
export function refreshStealthCaptureProtection(reason = "window-restore"): void {
  ensureControllers();
  stealthController.refresh(reason);
}
export function isStealthSupported(): boolean {
  ensureControllers();
  return stealthController.isSupported();
}
function logCaptureSurfaceState(reason: string, window: BrowserWindow): void {
  console.info("[window][capture-protection] surface lifecycle", {
    reason,
    ...getWindowCaptureDiagnostics(window),
  });
}
export function createMainWindow(): BrowserWindow {
  ensureControllers();
  const window = windowController.create();
  setNativeImeEnabled(window, false);
  return window;
}
export { app };
