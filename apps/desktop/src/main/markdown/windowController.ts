/** Owns normal, user-facing Markdown document windows and their file contexts. */
import { type FSWatcher, promises as fs, watch } from "node:fs";
import path from "node:path";
import { MarkdownChannels, type MarkdownDocument } from "@answra/shared";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { isWindowFromSender, prepareWindowToShow, registerWindowSurface } from "../window";
import { isMarkdownPath, resolveMarkdownImagePath } from "./path";

const windows = new Map<
  BrowserWindow,
  { path: string; watcher?: FSWatcher; lastSavedAt: number }
>();

async function readDocument(filePath: string): Promise<MarkdownDocument> {
  const resolved = path.resolve(filePath);
  if (!isMarkdownPath(resolved)) throw new Error("仅支持 Markdown 文件");
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("Markdown 路径不是文件");
  const text = await fs.readFile(resolved, "utf8");
  return { path: resolved, name: path.basename(resolved), text, mediaType: "text/markdown" };
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function readMarkdownImage(documentPath: string, reference: string): Promise<string> {
  const imagePath = resolveMarkdownImagePath(documentPath, reference);
  const documentDirectory = await fs.realpath(path.dirname(documentPath));
  const realImagePath = await fs.realpath(imagePath);
  const relativePath = path.relative(documentDirectory, realImagePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("图片路径超出文档目录");
  }
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(realImagePath).toLowerCase()];
  if (!mediaType) throw new Error("不支持的图片格式");
  const stat = await fs.stat(realImagePath);
  if (!stat.isFile()) throw new Error("图片路径不是文件");
  const image = await fs.readFile(realImagePath);
  return `data:${mediaType};base64,${image.toString("base64")}`;
}

export async function openMarkdownDocument(filePath: string): Promise<BrowserWindow | undefined> {
  const resolved = path.resolve(filePath);
  if (!isMarkdownPath(resolved)) return undefined;
  await readDocument(resolved);
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: path.basename(resolved),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--answra-markdown-path=${resolved}`],
    },
  });
  const entry: { path: string; watcher?: FSWatcher; lastSavedAt: number } = {
    path: resolved,
    lastSavedAt: 0,
  };
  windows.set(window, entry);
  registerWindowSurface(window, { role: "markdown-document", captureProtection: "never" });
  entry.watcher = watch(resolved, () => {
    if (Date.now() - entry.lastSavedAt < 1000) return;
    if (!window.isDestroyed())
      window.webContents.send(MarkdownChannels.Changed, { path: resolved });
  });
  window.once("ready-to-show", () => {
    if (prepareWindowToShow(window)) window.show();
  });
  window.on("closed", () => {
    entry.watcher?.close();
    windows.delete(window);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (app.isPackaged)
    await window.loadFile(path.join(__dirname, "../../dist/index.html"), {
      query: { surface: "markdown" },
    });
  else await window.loadURL("http://127.0.0.1:5180/?surface=markdown");
  return window;
}

export function getMarkdownContext(window: BrowserWindow): { path: string } {
  const context = windows.get(window);
  if (!context) throw new Error("文档窗口上下文不存在");
  return context;
}

export function registerMarkdownIpc(): void {
  ipcMain.handle(MarkdownChannels.GetDocument, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window) || !isWindowFromSender(window, event))
      throw new Error("非法来源");
    return readDocument(getMarkdownContext(window).path);
  });
  ipcMain.handle(MarkdownChannels.SaveDocument, async (event, request: { text?: unknown }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window) || !isWindowFromSender(window, event))
      throw new Error("非法来源");
    if (typeof request?.text !== "string") throw new Error("文档内容无效");
    const documentPath = getMarkdownContext(window).path;
    await fs.writeFile(documentPath, request.text, "utf8");
    const entry = windows.get(window);
    if (entry) entry.lastSavedAt = Date.now();
    window.setTitle(path.basename(documentPath));
  });
  ipcMain.handle(MarkdownChannels.OpenDocument, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window) || !isWindowFromSender(window, event))
      throw new Error("非法来源");
    const picked = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    await openMarkdownDocument(picked.filePaths[0] as string);
    return null;
  });
  ipcMain.handle(MarkdownChannels.ResolveImage, async (event, request: { reference?: unknown }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window) || !isWindowFromSender(window, event))
      throw new Error("非法来源");
    if (typeof request?.reference !== "string") throw new Error("图片路径无效");
    return readMarkdownImage(getMarkdownContext(window).path, request.reference);
  });
}
