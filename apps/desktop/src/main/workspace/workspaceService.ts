import { type FSWatcher, promises as fs, watch as fsWatch } from "node:fs";
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

/** watcher 工厂签名；测试可注入内存实现，运行时使用 Node 内置 `fs.watch`。 */
export type WatchFactory = (
  dir: string,
  listener: (paths: string[]) => void,
) => Promise<WatchHandle>;

export interface WorkspaceServiceOptions {
  /** 持久化目录（Electron userData），根目录缓存写在这里的 workspace.json。 */
  configDir: string;
  /** 变更监听工厂；缺省使用 Node 内置 `fs.watch` 递归监听。 */
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
  /** 自身写盘的时间戳（相对路径 → 时间）；用于抑制写盘经 watcher 回传为"外部变更"。 */
  private readonly selfWrites = new Map<string, number>();
  /** 写盘回声抑制窗口：覆盖 fs.watch 的异步延迟，超过即视为真实外部修改。 */
  private readonly selfWriteSuppressionMs = 1000;

  constructor(options: WorkspaceServiceOptions) {
    this.configDir = options.configDir;
    this.watchFactory = options.watchFactory ?? nodeWatchFactory;
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
    this.selfWrites.set(relPath.split(/[\\/]/).join("/"), Date.now());
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
        if (relativePaths.length === 0) return;
        // 过滤自身写盘引起的 watcher 回声：这些不是外部修改，不应推给渲染进程。
        const reportable = relativePaths.filter((changed) => {
          const when = this.selfWrites.get(changed);
          if (when !== undefined && Date.now() - when < this.selfWriteSuppressionMs) {
            this.selfWrites.delete(changed);
            return false;
          }
          return true;
        });
        if (reportable.length > 0) this.onChange?.(reportable);
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
 * 缺省 watcher 工厂：Node 内置 `fs.watch` 递归监听（无原生依赖）。
 *
 * `fs.watch` 的 `recursive` 选项在 Linux 不支持，这里改为手动逐层 watch：
 * 启动时先遍历目录树为每个子目录建立监听，新建子目录时再补挂监听。
 * 所有变更经 300ms 合并后统一回调，避免一次操作触发大量刷新。
 */
const nodeWatchFactory: WatchFactory = async (dir, listener) => {
  const watchers = new Set<FSWatcher>();
  const watchedDirs = new Set<string>();
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const schedule = (...paths: string[]) => {
    pending.push(...paths);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length) listener(batch);
    }, 300);
  };

  const watchDir = async (target: string) => {
    if (watchedDirs.has(target)) return;
    try {
      const watcher = fsWatch(target, (_event, filename) => {
        if (!filename) return;
        const full = path.join(target, filename);
        schedule(full);
        // 新创建的子目录需要补挂监听。
        fs.stat(full)
          .then((stat) => {
            if (stat.isDirectory()) void watchDir(full);
          })
          .catch(() => undefined);
      });
      watchers.add(watcher);
      watchedDirs.add(target);
      watcher.on("error", () => {
        watchers.delete(watcher);
        watchedDirs.delete(target);
      });
    } catch {
      // 不可监听的目录（权限不足等）直接跳过。
    }
  };

  const walk = async (root: string) => {
    await watchDir(root);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(root, entry.name));
    }
  };

  await walk(dir);

  return {
    unsubscribe: async () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchers.clear();
      watchedDirs.clear();
    },
  };
};
