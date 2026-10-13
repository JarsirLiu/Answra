import type { WorkspaceChangeSet, WorkspaceCreateRequest } from "@answra/shared";
import { WorkspaceChannels } from "@answra/shared";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import { isWindowFromSender } from "../window";
import type { WorkspaceService } from "./workspaceService";

/**
 * 工作区 IPC 薄壳：频道 → WorkspaceService 的纯转发，不承载业务逻辑。
 * 所有 handler 都校验来源窗口；service 抛出的错误原样传回渲染进程。
 */
export function registerWorkspaceIpc(
  service: WorkspaceService,
  getWindow: () => BrowserWindow | undefined,
  isStealthEnabled: () => boolean,
): void {
  ipcMain.handle(WorkspaceChannels.GetRoot, (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
    return { root: service.getRoot() };
  });

  ipcMain.handle(WorkspaceChannels.PickRoot, async (event) => {
    if (!isWindowFromSender(getWindow(), event)) return { root: null };
    const window = getWindow();
    if (!window) return { root: null };
    if (isStealthEnabled()) {
      console.info("[workspace] directory picker blocked while stealth is enabled");
      return { root: null };
    }
    const picked = await dialog.showOpenDialog(window, {
      title: "选择工作区目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { root: null };
    const root = await service.setRoot(picked.filePaths[0] as string);
    return { root };
  });

  ipcMain.handle(WorkspaceChannels.ListTree, async (event) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
    return service.listTree();
  });

  ipcMain.handle(WorkspaceChannels.ReadFile, async (event, request: { path: string }) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
    return service.readFile(String(request?.path ?? ""));
  });

  ipcMain.handle(
    WorkspaceChannels.WriteFile,
    async (event, request: { path: string; text: string }) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
      await service.writeFile(String(request?.path ?? ""), String(request?.text ?? ""));
    },
  );

  ipcMain.handle(
    WorkspaceChannels.WriteBytes,
    async (event, request: { path: string; dataBase64: string }) => {
      if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
      await service.writeBytes(String(request?.path ?? ""), String(request?.dataBase64 ?? ""));
    },
  );

  ipcMain.handle(WorkspaceChannels.CreateEntry, async (event, request: WorkspaceCreateRequest) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
    const kind = request?.kind === "dir" ? "dir" : "file";
    await service.createEntry(String(request?.path ?? ""), kind);
  });

  ipcMain.handle(WorkspaceChannels.DeleteEntry, async (event, request: { path: string }) => {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法来源");
    await service.removeEntry(String(request?.path ?? ""));
  });

  service.onLocalChange((paths) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    const change: WorkspaceChangeSet = { paths };
    window.webContents.send(WorkspaceChannels.Changed, change);
  });
}
