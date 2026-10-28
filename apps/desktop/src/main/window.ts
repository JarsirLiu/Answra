import {
  AuthChannels,
  type AuthStatus,
  type ContentSize,
  type ConversationChange,
  ConversationChannels,
  type RegionSelection,
  type ReplyBarAction,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, type BrowserWindow } from "electron";
import { createMainWindowController } from "./mainWindowController";
import { createReplyBarWindowController } from "./replyBarWindowController";
import { getWindowCaptureDiagnostics } from "./windowCaptureProtection";
import { createWindowStealthController } from "./windowStealthController";
import { createWindowSurfaceRegistry, type WindowSurfaceDescriptor } from "./windowSurfaceRegistry";

let windowController: ReturnType<typeof createMainWindowController>;
let stealthController: ReturnType<typeof createWindowStealthController>;
let replyBarController: ReturnType<typeof createReplyBarWindowController>;
const windowSurfaceRegistry = createWindowSurfaceRegistry();

export function registerWindowSurface(
  window: BrowserWindow,
  descriptor: WindowSurfaceDescriptor,
): () => void {
  return windowSurfaceRegistry.register(window, descriptor);
}

export function prepareWindowToShow(window: BrowserWindow): boolean {
  return windowSurfaceRegistry.prepareToShow(window);
}

export function prepareWindowCaptureProtection(window: BrowserWindow): boolean {
  return windowSurfaceRegistry.prepareCaptureProtection(window);
}

function ensureControllers(): void {
  if (windowController) return;
  windowController = createMainWindowController({
    registerWindowSurface,
    prepareWindowToShow,
    onClosed: () => replyBarController?.close(),
  });
  replyBarController = createReplyBarWindowController({
    getMainWindow: () => windowController.getWindow(),
    registerWindowSurface,
    prepareWindowToShow,
    logCaptureSurfaceState,
    sendReplyBarAction,
  });
  stealthController = createWindowStealthController({
    getMainWindow: () => windowController.getWindow(),
    applyWindowPolicies: (enabled) => windowSurfaceRegistry.setStealthEnabled(enabled),
    refreshWindowPolicies: (reason) => windowSurfaceRegistry.refresh(reason),
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
/** 把账号状态推给所有还活着的窗口（主悬浮条与独立回复窗口都要能刷门禁）。 */
export function sendAuthStatus(status: AuthStatus): void {
  for (const target of [getWindow(), getReplyBarWindow()]) {
    if (target && !target.isDestroyed()) target.webContents.send(AuthChannels.Status, status);
  }
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
/**
 * 迁移期单点开关：独立回复窗口入口已关闭。
 * 主窗口已统一改为内联 ReplySlot（useReplyWorkflow inline=true），此开关为防回退兜底：
 * 即使有调用方误推非空状态也不会创建/激活独立窗口，只放行 null 以清理残留。
 * 待内联形态实机验证通过后，连同 replyBarController 与 ReplyBarWindowApp 一并移除。
 */
const DETACHED_REPLY_WINDOW_ENABLED: boolean = false;

export function setReplyBarWindowState(state: ReplyBarState | null): void {
  ensureControllers();
  if (state !== null && !DETACHED_REPLY_WINDOW_ENABLED) return;
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
  return window;
}
export { app };
