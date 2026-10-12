import {
  type ContentSize,
  type ReplyBarAction,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import { ipcMain } from "electron";
import {
  applyStealth,
  getWindow,
  isReplyBarWindowFromSender,
  isStealthSupported,
  isWindowFromSender,
  resizeReplyBarWindow,
  resizeWindowToContent,
  sendReplyBarAction,
  sendReplyBarState,
  setReplyBarWindowState,
} from "../window";

/**
 * 窗口控制 IPC。
 * 频道常量与载荷类型来自 @answra/shared/channels，
 * 渲染进程只能通过 preload 暴露的桥访问，不直接触碰 ipcRenderer。
 */
export function registerWindowIpc(): void {
  ipcMain.on(WindowChannels.FitContent, (event, size: ContentSize) => {
    if (!isWindowFromSender(getWindow(), event)) return;
    if (!isValidSize(size)) return;
    resizeWindowToContent(size);
  });

  ipcMain.on(WindowChannels.Close, (event) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) return;
    window?.close();
  });

  ipcMain.on(WindowChannels.SetStealth, (event, value: boolean) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) {
      console.warn("[settings][stealth] rejected IPC sender", {
        senderId: event.sender.id,
        windowWebContentsId: window?.webContents.id,
      });
      return;
    }
    if (typeof value !== "boolean") {
      console.warn("[settings][stealth] rejected invalid IPC value", value);
      return;
    }
    applyStealth(value);
  });

  ipcMain.handle(WindowChannels.GetStealthSupport, (event) => {
    const window = getWindow();
    if (!isWindowFromSender(window, event)) {
      console.warn("[settings][stealth] rejected capability query sender", {
        senderId: event.sender.id,
        windowWebContentsId: window?.webContents.id,
      });
      return false;
    }
    return isStealthSupported();
  });

  ipcMain.on(WindowChannels.SetReplyBarState, (event, state: ReplyBarState | null) => {
    if (!isWindowFromSender(getWindow(), event) || !isValidReplyBarState(state)) return;
    setReplyBarWindowState(state);
  });

  ipcMain.on(WindowChannels.FitReplyBar, (event, size: ContentSize) => {
    if (!isReplyBarWindowFromSender(event) || !isValidSize(size)) return;
    resizeReplyBarWindow(size);
  });

  ipcMain.on(WindowChannels.ReplyBarAction, (event, action: unknown) => {
    if (!isReplyBarWindowFromSender(event) || !isValidReplyBarAction(action)) return;
    sendReplyBarAction(action);
  });

  ipcMain.on(WindowChannels.ReplyBarReady, (event) => {
    if (!isReplyBarWindowFromSender(event)) return;
    sendReplyBarState();
  });
}

function isValidSize(size: ContentSize): boolean {
  return (
    typeof size === "object" &&
    size !== null &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

function isValidReplyBarState(state: ReplyBarState | null): boolean {
  return (
    state === null ||
    (typeof state === "object" &&
      (state.phase === "composing" || state.phase === "streaming") &&
      Array.isArray(state.attachments) &&
      state.attachments.every(
        (attachment) =>
          typeof attachment?.id === "string" &&
          typeof attachment.name === "string" &&
          typeof attachment.previewUrl === "string",
      ) &&
      typeof state.draft === "string" &&
      typeof state.replyText === "string" &&
      Array.isArray(state.replyActivities) &&
      state.replyActivities.every(
        (activity) =>
          typeof activity?.id === "string" &&
          ["thinking", "text", "tool", "status", "source", "error"].includes(activity.kind) &&
          typeof activity.label === "string" &&
          typeof activity.text === "string",
      ) &&
      (state.replyError === undefined || typeof state.replyError === "string") &&
      (state.replyPending === undefined || typeof state.replyPending === "boolean") &&
      typeof state.stealth === "boolean" &&
      typeof state.theme?.variables === "object" &&
      state.theme.variables !== null &&
      Object.values(state.theme.variables).every((value) => typeof value === "string"))
  );
}

function isValidReplyBarAction(action: unknown): action is ReplyBarAction {
  if (typeof action !== "object" || action === null) return false;
  const candidate = action as {
    type?: unknown;
    value?: unknown;
    id?: unknown;
    attachment?: unknown;
  };
  if (["send", "cancel", "close", "screenshot/start"].includes(String(candidate.type))) return true;
  if (candidate.type === "draft/change") return typeof candidate.value === "string";
  if (candidate.type === "attachment/remove") return typeof candidate.id === "string";
  if (
    candidate.type !== "attachment/add" ||
    typeof candidate.attachment !== "object" ||
    candidate.attachment === null
  ) {
    return false;
  }
  const attachment = candidate.attachment as { id?: unknown; name?: unknown; previewUrl?: unknown };
  return (
    typeof attachment.id === "string" &&
    typeof attachment.name === "string" &&
    typeof attachment.previewUrl === "string"
  );
}
