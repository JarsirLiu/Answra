import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolCall, type ToolContext } from "../../../src/core/tool";
import { executeGrep, grepTool } from "../../../src/core/tool/builtin/grep";
import { formatGrepOutput } from "../../../src/core/tool/builtin/grepOutput";

function context(
  workspaceRoot: string | null,
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  return {
    toolCallId: "tool-call-1",
    signal,
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
  };
}

describe("Grep tool", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("uses ripgrep regex and content mode with line numbers", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "const value = 1;\nconst answer = 42;");

    const output = await executeGrep(context(root), {
      pattern: "\\b42\\b",
      output_mode: "content",
    });

    expect(formatGrepOutput(output)).toContain("src/a.ts:2:const answer = 42;");
    await expect(executeGrep(context(root), { pattern: "[" })).rejects.toThrow("regex parse error");
  });

  it("defaults to files_with_matches and lists each file once", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle\nneedle again");

    const output = await executeGrep(context(root), { pattern: "needle" });

    expect(output).toMatchObject({
      type: "files_with_matches",
      files: ["a.txt"],
      truncated: false,
    });
    expect(formatGrepOutput(output)).toBe("a.txt");
  });

  it("supports count output", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle\nskip\nneedle");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "count",
    });

    expect(formatGrepOutput(output)).toBe("a.txt:2");
  });

  it("filters by glob and type", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.ts"), "needle");
    await fs.writeFile(path.join(root, "b.md"), "needle");
    await fs.writeFile(path.join(root, "c.py"), "needle");
    await fs.writeFile(path.join(root, "Dockerfile"), "needle");

    const byGlob = await executeGrep(context(root), { pattern: "needle", glob: "*.ts" });
    const byType = await executeGrep(context(root), { pattern: "needle", type: "py" });
    const byExtensionless = await executeGrep(context(root), {
      pattern: "needle",
      glob: "Dockerfile",
    });

    expect(byGlob).toMatchObject({ type: "files_with_matches", files: ["a.ts"] });
    expect(byType).toMatchObject({ type: "files_with_matches", files: ["c.py"] });
    expect(formatGrepOutput(byExtensionless)).toBe("Dockerfile");
  });

  it("returns context lines and only matching text", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "before\nneedle after\nafter");

    const withContext = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      "-C": 1,
    });
    const onlyMatching = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      "-o": true,
    });

    expect(formatGrepOutput(withContext)).toContain("a.txt-1-before");
    expect(formatGrepOutput(withContext)).toContain("a.txt:2:needle after");
    expect(formatGrepOutput(withContext)).toContain("a.txt-3-after");
    expect(formatGrepOutput(onlyMatching)).toBe("a.txt:2:needle");
  });

  it("normalizes native paths and accepts absolute in-workspace paths", async () => {
    const root = await createRoot();
    await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "nested", "a.ts"), "needle");

    const relative = await executeGrep(context(root), {
      pattern: "needle",
      path: process.platform === "win32" ? "src\\nested/" : "src/nested/",
      output_mode: "content",
    });
    const absolute = await executeGrep(context(root), {
      pattern: "needle",
      path: path.join(root, "src"),
      output_mode: "content",
    });

    expect(formatGrepOutput(relative)).toBe("src/nested/a.ts:1:needle");
    expect(formatGrepOutput(absolute)).toBe("src/nested/a.ts:1:needle");
  });

  it("honors gitignore, includes dotfiles, and excludes VCS directories", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await fs.writeFile(path.join(root, "ignored.ts"), "needle");
    await fs.writeFile(path.join(root, ".env"), "needle=1");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "needle");

    const output = await executeGrep(context(root), { pattern: "needle" });

    expect(formatGrepOutput(output)).toContain(".env");
    expect(formatGrepOutput(output)).not.toContain("ignored.ts");
    expect(formatGrepOutput(output)).not.toContain(".git/config");
  });

  it("searches files larger than the old 128 KiB limit", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "large.txt"), `needle\n${"x".repeat(200 * 1024)}`);

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
    });

    expect(formatGrepOutput(output)).toContain("large.txt:1:needle");
  });

  it("pages matches with head_limit and offset", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle");
    await fs.writeFile(path.join(root, "b.txt"), "needle");

    const first = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      head_limit: 1,
    });
    const second = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      head_limit: 1,
      offset: 1,
    });

    expect(first).toMatchObject({
      type: "content",
      totalMatches: 2,
      shownMatches: 1,
      truncated: true,
    });
    expect(second).toMatchObject({
      type: "content",
      totalMatches: 2,
      shownMatches: 1,
      truncated: false,
    });
    expect(formatGrepOutput(first)).not.toBe(formatGrepOutput(second));
  });

  it("supports multiline matches", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "alpha\nbeta\ngamma");

    const output = await executeGrep(context(root), {
      pattern: "alpha\\nbeta",
      output_mode: "content",
      multiline: true,
    });

    expect(formatGrepOutput(output)).toContain("a.txt:1:alpha");
    expect(formatGrepOutput(output)).toContain("a.txt:2:beta");
  });

  it("returns a clear no-match message", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "content");

    const output = await executeGrep(context(root), { pattern: "missing" });

    expect(formatGrepOutput(output)).toBe("未找到匹配内容");
  });

  it("rejects missing paths but allows searches outside the workspace", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "needle");

    await expect(executeGrep(context(root), { pattern: "x", path: "missing" })).rejects.toThrow(
      "路径不存在",
    );

    const output = await executeGrep(context(root), {
      pattern: "needle",
      path: path.relative(root, outside),
      output_mode: "content",
    });

    expect(formatGrepOutput(output)).toContain(`${outsideFile.split(path.sep).join("/")}:1:needle`);
  });

  it("rejects an already-cancelled call", async () => {
    const root = await createRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(executeGrep(context(root, controller.signal), { pattern: "x" })).rejects.toThrow(
      "取消",
    );
  });

  it("caps model-visible output at 20,000 bytes", async () => {
    const root = await createRoot();
    await fs.writeFile(
      path.join(root, "large.txt"),
      Array.from({ length: 1_000 }, (_, index) => `needle ${index} ${"x".repeat(80)}`).join("\n"),
    );

    const result = await executeToolCall(
      grepTool,
      { pattern: "needle", output_mode: "content", head_limit: 0 },
      context(root),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.modelContent, "utf8")).toBeLessThanOrEqual(20_100);
  });

  it("rejects an invalid type filter", async () => {
    const root = await createRoot();

    await expect(
      executeGrep(context(root), { pattern: "needle", type: "bad type!" }),
    ).rejects.toMatchObject({ code: "invalid-input", message: "type 参数无效" });
  });

  it("maps an unknown type to an extension glob", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle");
    await fs.writeFile(path.join(root, "b.md"), "needle");

    const output = await executeGrep(context(root), { pattern: "needle", type: "txt" });

    expect(output).toMatchObject({ type: "files_with_matches", files: ["a.txt"] });
  });

  it("supports case-insensitive search", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "NEEDLE");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      "-i": true,
    });

    expect(formatGrepOutput(output)).toContain("a.txt:1:NEEDLE");
  });

  it("supports separate before and after context", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "before\nneedle\nafter");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      "-B": 1,
      "-A": 1,
    });

    expect(formatGrepOutput(output)).toContain("a.txt-1-before");
    expect(formatGrepOutput(output)).toContain("a.txt:2:needle");
    expect(formatGrepOutput(output)).toContain("a.txt-3-after");
  });

  it("omits line numbers when -n is false", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "content",
      "-n": false,
    });

    expect(formatGrepOutput(output)).toBe("a.txt:needle");
  });

  it("searches a single file path", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle");
    await fs.writeFile(path.join(root, "b.txt"), "needle");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      path: "a.txt",
      output_mode: "content",
    });

    expect(formatGrepOutput(output)).toBe("a.txt:1:needle");
  });

  it("pages file matches with offset and head_limit", async () => {
    const root = await createRoot();
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await fs.writeFile(path.join(root, name), "needle");
    }

    const paged = await executeGrep(context(root), {
      pattern: "needle",
      offset: 1,
      head_limit: 1,
    });
    const unlimited = await executeGrep(context(root), {
      pattern: "needle",
      head_limit: 0,
    });

    expect(paged).toMatchObject({ type: "files_with_matches", files: ["b.txt"], truncated: true });
    expect(formatGrepOutput(paged)).toContain("[结果达到上限]");
    expect(unlimited).toMatchObject({
      type: "files_with_matches",
      files: ["a.txt", "b.txt", "c.txt"],
    });
    expect(unlimited).toMatchObject({ truncated: false });
  });

  it("pages count output", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "a.txt"), "needle\nneedle");
    await fs.writeFile(path.join(root, "b.txt"), "needle");

    const output = await executeGrep(context(root), {
      pattern: "needle",
      output_mode: "count",
      head_limit: 1,
    });

    expect(output).toMatchObject({
      type: "count",
      counts: [{ path: "a.txt", count: 2 }],
      truncated: true,
    });
    expect(formatGrepOutput(output)).toContain("[结果达到上限]");
  });

  describe("worker path", () => {
    it("executes ripgrep through the configured worker script", async () => {
      const root = await createRoot();
      const workerPath = await createWorker(
        root,
        [
          'import { parentPort } from "node:worker_threads"',
          `const line = ${JSON.stringify(
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "a.txt" },
                lines: { text: "needle\n" },
                line_number: 1,
                submatches: [{ match: { text: "needle" } }],
              },
            }),
          )}`,
          'parentPort.postMessage({ ok: true, code: 0, stdout: line + "\\n", stderr: "" })',
        ].join("\n"),
      );

      const output = await executeGrep(contextWithWorker(root, workerPath), {
        pattern: "needle",
        output_mode: "content",
      });

      expect(formatGrepOutput(output)).toBe("a.txt:1:needle");
    });

    it("maps a worker business failure to handler-failed", async () => {
      const root = await createRoot();
      const workerPath = await createWorker(
        root,
        'import { parentPort } from "node:worker_threads"\nparentPort.postMessage({ ok: false, error: "worker boom" })',
      );

      await expect(
        executeGrep(contextWithWorker(root, workerPath), { pattern: "needle" }),
      ).rejects.toMatchObject({ code: "handler-failed", message: "worker boom" });
    });

    it("maps a worker that exits without a message to handler-failed", async () => {
      const root = await createRoot();
      const workerPath = await createWorker(root, "process.exit(0)");

      await expect(
        executeGrep(contextWithWorker(root, workerPath), { pattern: "needle" }),
      ).rejects.toMatchObject({ code: "handler-failed", message: "Grep worker 退出码 0" });
    });

    it("maps a worker load error to handler-failed", async () => {
      const root = await createRoot();

      await expect(
        executeGrep(contextWithWorker(root, path.join(root, "missing-worker.mjs")), {
          pattern: "needle",
        }),
      ).rejects.toMatchObject({ code: "handler-failed" });
    });

    it("cancels a pending worker and terminates it", async () => {
      const root = await createRoot();
      const workerPath = await createWorker(root, "setTimeout(() => {}, 60_000)");
      const controller = new AbortController();
      const pending = executeGrep(
        { ...context(root, controller.signal), workerPaths: { grep: workerPath } },
        { pattern: "needle" },
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: "aborted" });
    });
  });

  function contextWithWorker(root: string, workerPath: string): ToolContext {
    return { ...context(root), workerPaths: { grep: workerPath } };
  }

  async function createWorker(root: string, source: string): Promise<string> {
    const workerPath = path.join(root, `worker-${Math.random().toString(36).slice(2)}.mjs`);
    await fs.writeFile(workerPath, source, "utf8");
    return workerPath;
  }

  async function createRoot(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answra-grep-")));
    roots.push(root);
    return root;
  }
});
