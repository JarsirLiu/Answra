import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuiltinToolRegistry,
  type ReadFileStateMap,
  type ToolContext,
  type ToolSessionContext,
  toolId,
} from "../../../src/core/tool";
import { executeGrep } from "../../../src/core/tool/builtin/grep";
import { executeRead } from "../../../src/core/tool/builtin/read";
import { formatReadOutput } from "../../../src/core/tool/builtin/readOutput";

function context(
  workspaceRoot: string | null,
  signal: AbortSignal = new AbortController().signal,
  readFileState?: ReadFileStateMap,
): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal,
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    ...(readFileState ? { readFileState } : {}),
  };
}

function sessionContext(
  workspaceRoot: string | null,
  signal: AbortSignal = new AbortController().signal,
): ToolSessionContext {
  return { signal, workspaceRoot, runId: "run-1", sessionId: "session-1" };
}

describe("builtin workspace tools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("exposes only authorized builtin tools with their registered model names", () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.authorize([toolId("workspace.read")], sessionContext(null));

    expect(registry.list().map(({ id, metadata }) => [id, metadata.name])).toEqual([
      ["workspace.read", "Read"],
      ["workspace.grep", "Grep"],
    ]);
    expect(Object.keys(tools)).toEqual(["Read"]);
  });

  it("reads bounded line ranges and searches matching content inside the Agent process", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(
      path.join(root, "notes", "plan.md"),
      "Review\nAgent foundation\nDone",
      "utf8",
    );
    await fs.mkdir(path.join(root, ".private"));
    await fs.writeFile(path.join(root, ".private", "hidden.md"), "Agent secret", "utf8");
    const toolContext = context(root);
    const readResult = await executeRead(toolContext, {
      file_path: "notes/plan.md",
      offset: 2,
      limit: 1,
    });
    const grepResult = await executeGrep(toolContext, { pattern: "Agent" });

    expect(readResult).toMatchObject({
      type: "text",
      numLines: 1,
      startLine: 2,
      totalLines: 3,
      truncated: false,
    });
    expect(formatReadOutput(readResult)).toContain("2\tAgent foundation");
    expect(grepResult).toContain("notes/plan.md:2:Agent foundation");
    expect(grepResult).not.toContain("hidden.md");
  });

  it("reads empty files, extensionless files, absolute paths, and past-end offsets", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "plan.md"), "Review\nAgent foundation\nDone");
    await fs.writeFile(path.join(root, "Dockerfile"), "FROM node");
    await fs.writeFile(path.join(root, "empty.md"), "");
    const toolContext = context(root);

    const absolute = await executeRead(toolContext, {
      file_path: path.join(root, "notes", "plan.md"),
    });
    expect(absolute).toMatchObject({ type: "text", filePath: path.join(root, "notes", "plan.md") });
    expect(formatReadOutput(absolute)).toContain("1\tReview");

    const extensionless = await executeRead(toolContext, { file_path: "Dockerfile" });
    expect(formatReadOutput(extensionless)).toContain("1\tFROM node");

    const empty = await executeRead(toolContext, { file_path: "empty.md" });
    expect(empty).toMatchObject({ type: "text", content: "", numLines: 0, totalLines: 0 });
    expect(formatReadOutput(empty)).toContain("内容为空");

    const pastEnd = await executeRead(toolContext, { file_path: "notes/plan.md", offset: 99 });
    expect(pastEnd).toMatchObject({ type: "text", content: "", totalLines: 3 });
    expect(formatReadOutput(pastEnd)).toContain("文件只有 3 行");
  });

  it("returns the whole file by default and a continuation view only over the token cap", async () => {
    const root = await createRoot();
    const fullText = Array.from({ length: 3_000 }, () => "x".repeat(20)).join("\n");
    await fs.writeFile(path.join(root, "full.md"), fullText);
    await fs.writeFile(
      path.join(root, "large.md"),
      Array.from({ length: 6_000 }, () => "x".repeat(20)).join("\n"),
    );

    const full = await executeRead(context(root), { file_path: "full.md" });
    expect(full).toMatchObject({ type: "text", numLines: 3_000, truncated: false });
    expect(formatReadOutput(full)).not.toContain("超过单次读取上限");

    const large = await executeRead(context(root), { file_path: "large.md" });
    expect(large).toMatchObject({ type: "text", truncated: true, truncatedByTokenCap: true });
    expect(formatReadOutput(large)).toContain("offset=");
  });

  it("truncates a single over-budget line without inventing a continuation offset", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "single-line.md"), "x".repeat(100_000));
    const result = await executeRead(context(root), { file_path: "single-line.md" });
    const modelContent = formatReadOutput(result);

    expect(result).toMatchObject({ type: "text", truncated: true, truncatedByTokenCap: true });
    expect(modelContent).toContain("第一行本身超过预算");
    expect(modelContent).not.toContain("offset=");
  });

  it("rejects whole-file reads above 256 KiB but allows an explicit range", async () => {
    const root = await createRoot();
    const largeLines = Array.from({ length: 30_000 }, () => "x".repeat(10)).join("\n");
    await fs.writeFile(path.join(root, "too-large.md"), largeLines);

    await expect(executeRead(context(root), { file_path: "too-large.md" })).rejects.toThrow(
      "单次读取上限",
    );
    await expect(
      executeRead(context(root), { file_path: "too-large.md", limit: 1 }),
    ).resolves.toMatchObject({ type: "text", numLines: 1, content: "x".repeat(10) });
  });

  it("returns file_unchanged for a repeated range until the file changes", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "state.md");
    await fs.writeFile(filePath, "first");
    const state: ReadFileStateMap = new Map();
    const toolContext = context(root, new AbortController().signal, state);

    const first = await executeRead(toolContext, { file_path: "state.md" });
    const unchanged = await executeRead(toolContext, { file_path: "state.md" });

    expect(first).toMatchObject({ type: "text" });
    expect(unchanged).toMatchObject({ type: "file_unchanged", filePath });
    expect(formatReadOutput(unchanged)).toContain("file unchanged");

    await fs.writeFile(filePath, "second-change");
    await expect(executeRead(toolContext, { file_path: "state.md" })).resolves.toMatchObject({
      type: "text",
      content: "second-change",
    });
  });

  it("suggests a similar filename when the requested file is missing", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "plan.md"), "content");

    await expect(executeRead(context(root), { file_path: "notes/plan.txt" })).rejects.toThrow(
      "是否想找 notes/plan.md",
    );
  });

  it("decodes UTF-16 text with a BOM", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "utf16.md"), Buffer.from("\uFEFFHello\n中文", "utf16le"));

    const result = await executeRead(context(root), { file_path: "utf16.md" });
    const modelContent = formatReadOutput(result);

    expect(modelContent).toContain("Hello");
    expect(modelContent).toContain("中文");
  });

  it("rejects traversal, symlink escapes, binary files, hidden files, invalid patterns, and cancellation", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await fs.symlink(outside, path.join(root, "escape"), "junction");
    await fs.writeFile(path.join(root, "document.bin"), Buffer.from([0, 1, 2]));
    await fs.mkdir(path.join(root, ".private"));
    await fs.writeFile(path.join(root, ".private", "hidden.md"), "secret");
    const controller = new AbortController();
    const toolContext = context(root, controller.signal);
    await expect(executeRead(toolContext, { file_path: "../secret.md" })).rejects.toThrow(
      "工作区内的文件路径",
    );
    await expect(executeRead(toolContext, { file_path: "escape/secret.md" })).rejects.toThrow(
      "路径超出",
    );
    await expect(
      executeRead(toolContext, { file_path: path.join(outside, "secret.md") }),
    ).rejects.toThrow("路径超出");
    await expect(executeRead(toolContext, { file_path: "document.bin" })).rejects.toThrow("UTF-8");
    await expect(executeRead(toolContext, { file_path: ".private/hidden.md" })).rejects.toThrow(
      "隐藏",
    );
    await expect(executeGrep(toolContext, { pattern: "secret" })).resolves.toContain("未找到");
    controller.abort();
    await expect(executeRead(toolContext, { file_path: "document.bin" })).rejects.toThrow("取消");
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-agent-tools-"));
    roots.push(root);
    return root;
  }
});
