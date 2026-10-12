import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "../src/main/workspace/workspaceService";

/**
 * 领域逻辑单测：路径边界校验、目录树枚举、根目录缓存与 watcher 工厂注入。
 * watcher 使用内存工厂，不加载 @parcel/watcher 原生二进制。
 */
describe("workspaceService", () => {
  let configDir: string;
  let rootDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "answra-config-"));
    rootDir = await mkdtemp(path.join(tmpdir(), "answra-root-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    await rm(rootDir, { recursive: true, force: true });
  });

  function createService(overrides?: Partial<ConstructorParameters<typeof WorkspaceService>[0]>) {
    const listeners: Array<(paths: string[]) => void> = [];
    const service = new WorkspaceService({
      configDir,
      watchFactory: async (_dir, listener) => {
        listeners.push(listener);
        return { unsubscribe: async () => undefined };
      },
      ...overrides,
    });
    return { service, listeners };
  }

  it("rejects paths outside the workspace root", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);

    expect(() => service.resolve("../outside.txt")).toThrow("路径超出工作区范围");
    expect(() => service.resolve("C:/Windows/system32")).toThrow("路径超出工作区范围");
    expect(() => service.resolve("a/../../b")).toThrow("路径超出工作区范围");
    expect(path.join(rootDir, "notes/a.md")).toBe(service.resolve("notes/a.md"));
  });

  it("throws before a root is selected", () => {
    const { service } = createService();
    expect(() => service.resolve("a.md")).toThrow("尚未选择工作区目录");
    expect(service.getRoot()).toBeNull();
  });

  it("lists a sorted tree with directories first and skips hidden folders", async () => {
    await mkdir(path.join(rootDir, "数学"));
    await mkdir(path.join(rootDir, ".git"));
    await mkdir(path.join(rootDir, "node_modules"));
    await writeFile(path.join(rootDir, "数学", "错题.md"), "# 错题");
    await writeFile(path.join(rootDir, "阅读.md"), "笔记");
    await writeFile(path.join(rootDir, ".git", "config"), "x");

    const { service } = createService();
    await service.setRoot(rootDir);
    const tree = await service.listTree();

    expect(tree.map((node) => node.path)).toEqual(["数学", "数学/错题.md", "阅读.md"]);
    expect(tree[0]).toMatchObject({ kind: "dir" });
    expect(tree[1]).toMatchObject({ kind: "file" });
  });

  it("reads and writes text files and rejects binary extensions for text writes", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);
    await service.writeFile("a.md", "# 你好");
    const content = await service.readFile("a.md");
    expect(content.text).toBe("# 你好");
    expect(content.mediaType).toBe("text/markdown");

    await expect(service.writeFile("a.png", "text")).rejects.toThrow("仅支持写入文本文件");
  });

  it("writes image bytes only for image extensions and size limits", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);
    const base64 = Buffer.from("png-bytes").toString("base64");
    await service.writeBytes("assets/pic.png", base64);
    const saved = await readFile(path.join(rootDir, "assets", "pic.png"));
    expect(saved.toString()).toBe("png-bytes");

    await expect(service.writeBytes("evil.md", base64)).rejects.toThrow("仅支持写入图片文件");
    await expect(service.writeBytes("assets/big.png", "x".repeat(17_000_000))).rejects.toThrow(
      "文件内容无效或过大",
    );
  });

  it("creates and removes entries with guards", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);
    await service.createEntry("2026/数学", "dir");
    await service.createEntry("2026/数学/笔记.md", "file");
    await expect(readFile(path.join(rootDir, "2026", "数学", "笔记.md"))).resolves.toBeDefined();
    await expect(service.createEntry("2026/数学/笔记.md", "file")).rejects.toThrow();
    await expect(service.createEntry("binary.exe", "file")).rejects.toThrow("仅支持新建");
    await expect(service.removeEntry(".")).rejects.toThrow();

    await service.removeEntry("2026");
    await expect(readFile(path.join(rootDir, "2026", "数学", "笔记.md"))).rejects.toThrow();
  });

  it("caches the root and restores it while the directory exists", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);
    expect(await readFile(path.join(configDir, "workspace.json"), "utf8")).toContain("root");

    const second = createService();
    expect(await second.service.restoreRoot()).toBe(rootDir);
    expect(second.service.getRoot()).toBe(rootDir);
  });

  it("clears the cached root when the directory no longer exists", async () => {
    const { service } = createService();
    await service.setRoot(rootDir);
    await rm(rootDir, { recursive: true, force: true });
    expect(await service.restoreRoot()).toBeNull();
    expect(service.getRoot()).toBeNull();
    await expect(readFile(path.join(configDir, "workspace.json"))).rejects.toThrow();
  });

  it("forwards watcher events through the injected factory", async () => {
    const { service, listeners } = createService();
    const onChange = vi.fn();
    service.onLocalChange(onChange);
    await service.setRoot(rootDir);
    expect(listeners.length).toBe(1);

    listeners[0]?.([path.join(rootDir, "a.md")]);
    expect(onChange).toHaveBeenCalledWith(["a.md"]);

    // 切换根目录后旧监听解绑、新 watcher 建立。
    const other = await mkdtemp(path.join(tmpdir(), "answra-root2-"));
    try {
      await service.setRoot(other);
      expect(listeners.length).toBe(2);
      onChange.mockClear();
      listeners[0]?.([path.join(rootDir, "stale.md")]);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
