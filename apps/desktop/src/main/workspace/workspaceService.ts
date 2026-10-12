import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * 工作区领域服务：根目录管理、路径边界校验、目录树枚举、文件读写与变更监听。
 *
 * 本模块只依赖 Node 内置模块与注入的 watcher 工厂，不 import Electron，
 * 便于在 node 测试环境直接验证领域逻辑；Electron 侧接线见 workspaceIpc.ts。
 */

export interface WatchHandle {
  unsubscribe: () => Promise<void>;
}

/** watcher 工厂签名；与 @parcel/watcher 的 `watch` 兼容，测试可注入内存实现。 */
export type WatchFactory = (
  dir: string,
  listener: (paths: string[]) => void,
) => Promise<WatchHandle>;

export interface WorkspaceServiceOptions {
  /** 持久化目录（Electron userData），根目录缓存写在这里的 workspace.json。 */
  configDir: string;
  /** 变更监听工厂；缺省使用 @parcel/watcher 递归监听。 */
  watchFactory?: WatchFactory;
  /** 目录树枚举的最大深度，防止超大目录拖垮 IPC。 */
  maxDepth?: number;
  /** 目录树枚举的最大节点数。 */
  maxNodes?: number;
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super("尚未选择工作区目录");
  }
}

export class PathOutsideRootError extends Error {
  constructor() {
    super("路径超出工作区范围");
  }
}

const ROOT_CACHE_FILE = "workspace.json";
/** 跳过的目录名（隐藏目录与依赖目录）。 */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".svn", "dist", "out"]);

/** 扩展名 → 媒体类型推断。 */
const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export class WorkspaceService {
  private root: string | null = null;
  private readonly configDir: string;
  private readonly watchFactory: WatchFactory;
  private readonly maxDepth: number;
  private readonly maxNodes: number;
  private handle: WatchHandle | null = null;

  constructor(options: WorkspaceServiceOptions) {
    this.configDir = options.configDir;
    this.watchFactory = options.watchFactory ?? parcelWatchFactory;
    this.maxDepth = options.maxDepth ?? 8;
    this.maxNodes = options.maxNodes ?? 5000;
  }

  /** 启动时恢复上次根目录；目录已不存在时忽略并清除缓存。 */
  async restoreRoot(): Promise<string | null> {
    this.root = null;
    await this.stopWatching();
    const cached = await this.readRootCache();
    if (!cached) return null;
    try {
      const stat = await fs.stat(cached);
      if (!stat.isDirectory()) throw new Error("not a directory");
      await this.setRoot(cached);
      return this.root;
    } catch {
      await this.saveRootCache(null);
      return null;
    }
  }

  getRoot(): string | null {
    return this.root;
  }

  /** 设置新根目录并重建 watcher；目录不存在时抛错。 */
  async setRoot(dir: string): Promise<string> {
    const resolved = path.resolve(dir);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error("所选路径不是目录");
    await this.stopWatching();
    this.root = resolved;
    await this.saveRootCache(resolved);
    await this.startWatching();
    return resolved;
  }

  /** 把相对路径解析为根目录内的绝对路径；越界或非法输入抛 PathOutsideRootError。 */
  resolve(relPath: string): string {
    if (!this.root) throw new WorkspaceNotFoundError();
    if (typeof relPath !== "string" || relPath.length > 1024) throw new PathOutsideRootError();
    if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) throw new PathOutsideRootError();
    const segments = relPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    for (const segment of segments) {
      if (segment === "." || segment === ".." || segment === "~") throw new PathOutsideRootError();
    }
    const resolved = path.resolve(this.root, ...segments);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new PathOutsideRootError();
    return resolved;
  }

  /** 枚举目录树（目录优先、名称排序；跳过隐藏/依赖目录）。 */
  async listTree(): Promise<ReturnType<WorkspaceService["buildTree"]>> {
    if (!this.root) throw new WorkspaceNotFoundError();
    return this.buildTree(this.root, "", 0);
  }

  async readFile(relPath: string): Promise<{
    mediaType: string;
    dataBase64: string;
    text: string | null;
  }> {
    const absolute = this.resolve(relPath);
    const data = await fs.readFile(absolute);
    const mediaType = inferMediaType(absolute);
    const text = TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())
      ? data.toString("utf8")
      : null;
    return { mediaType, dataBase64: data.toString("base64"), text };
  }

  async writeFile(relPath: string, text: string): Promise<void> {
    if (typeof text !== "string") throw new Error("文件内容无效");
    const absolute = this.resolve(relPath);
    if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase()))
      throw new Error("仅支持写入文本文件");
    await fs.writeFile(absolute, text, "utf8");
  }

  /** 写入二进制文件；仅允许图片扩展名，供粘贴截图落盘。 */
  async writeBytes(relPath: string, dataBase64: string): Promise<void> {
    if (typeof dataBase64 !== "string" || dataBase64.length === 0 || dataBase64.length > 16_000_000)
      throw new Error("文件内容无效或过大");
    const absolute = this.resolve(relPath);
    if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase()))
      throw new Error("仅支持写入图片文件");
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0) throw new Error("文件内容无效");
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data);
  }

  async createEntry(relPath: string, kind: "dir" | "file"): Promise<void> {
    const absolute = this.resolve(relPath);
    if (kind === "dir") {
      await fs.mkdir(absolute, { recursive: true });
      return;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase()))
      throw new Error("仅支持新建 md 等文本文档");
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const handle = await fs.open(absolute, "wx");
    await handle.close();
  }

  async removeEntry(relPath: string): Promise<void> {
    const absolute = this.resolve(relPath);
    if (absolute === this.root) throw new PathOutsideRootError();
    await fs.rm(absolute, { recursive: true, force: false });
  }

  async dispose(): Promise<void> {
    await this.stopWatching();
  }

  private async buildTree(
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<Array<{ name: string; path: string; kind: "dir" | "file" }>> {
    if (depth > this.maxDepth) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return [];
    const nodes: Array<{ name: string; path: string; kind: "dir" | "file" }> = [];
    const dirs: Array<string> = [];
    const files: Array<string> = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      (entry.isDirectory() ? dirs : files).push(entry.name);
    }
    const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });
    dirs.sort(collator.compare);
    files.sort(collator.compare);
    for (const name of dirs) {
      nodes.push({ name, path: joinRel(prefix, name), kind: "dir" });
      if (nodes.length > this.maxNodes) return nodes;
      nodes.push(...(await this.buildTree(path.join(dir, name), joinRel(prefix, name), depth + 1)));
      if (nodes.length > this.maxNodes) return nodes;
    }
    for (const name of files) {
      nodes.push({ name, path: joinRel(prefix, name), kind: "file" });
      if (nodes.length > this.maxNodes) return nodes;
    }
    return nodes;
  }

  private async startWatching(): Promise<void> {
    if (!this.root) return;
    const root = this.root;
    let active = true;
    try {
      const handle = await this.watchFactory(root, (paths) => {
        if (!active || this.root !== root) return;
        const relativePaths = paths
          .map((filePath) => (path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath))
          .filter(
            (filePath) => filePath && !filePath.startsWith("..") && !path.isAbsolute(filePath),
          )
          .map((filePath) => filePath.split(path.sep).join("/"));
        if (relativePaths.length > 0) this.onChange?.(relativePaths);
      });
      this.handle = {
        unsubscribe: async () => {
          active = false;
          await handle.unsubscribe();
        },
      };
    } catch (error) {
      console.warn("[workspace] watcher 启动失败", error);
      this.handle = null;
    }
  }

  private async stopWatching(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.unsubscribe().catch(() => undefined);
  }

  /** watcher 变更回调（由工厂注入的 listener 触发后转发给 IPC 层）。 */
  private onChange?: (paths: string[]) => void;

  /** 注册变更监听（IPC 层调用）；返回取消注册函数。 */
  onLocalChange(listener: (paths: string[]) => void): () => void {
    this.onChange = listener;
    return () => {
      if (this.onChange === listener) this.onChange = undefined;
    };
  }

  private async readRootCache(): Promise<string | null> {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.configDir, ROOT_CACHE_FILE), "utf8"),
      ) as { root?: string };
      return typeof raw.root === "string" && raw.root.length > 0 ? raw.root : null;
    } catch {
      return null;
    }
  }

  private async saveRootCache(root: string | null): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const file = path.join(this.configDir, ROOT_CACHE_FILE);
    if (!root) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.writeFile(file, JSON.stringify({ root }), "utf8");
  }
}

function joinRel(prefix: string, name: string): string {
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function inferMediaType(absolutePath: string): string {
  return MEDIA_TYPES[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 缺省 watcher 工厂：@parcel/watcher 递归监听 + 简单合并。
 * 依赖经 createRequire 惰性加载，测试注入工厂时不触发原生二进制加载。
 */
const parcelWatchFactory: WatchFactory = (dir, listener) => {
  const require = createRequire(import.meta.url);
  const { watch } = require("@parcel/watcher") as {
    watch: (
      dir: string,
      callback: (error: Error | null, events: Array<{ type: string; path: string }>) => void,
    ) => { unsubscribe: () => Promise<void> };
  };
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  const subscription = watch(dir, (error, events) => {
    if (error) {
      console.warn("[workspace] watcher error", error);
      return;
    }
    pending.push(...events.map((event) => event.path));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = pending;
      pending = [];
      listener(paths);
    }, 300);
  });
  return Promise.resolve({
    unsubscribe: () => {
      if (timer) clearTimeout(timer);
      return subscription.unsubscribe();
    },
  });
};
