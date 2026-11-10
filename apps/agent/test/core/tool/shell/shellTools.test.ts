import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolCall, type ToolContext, type ToolResult } from "../../../../src/core/tool";
import type {
  ShellSessionSnapshot,
  ShellYieldTimePolicy,
} from "../../../../src/core/tool/builtin/shell/sessions";
import { createShellTools, type ShellTools } from "../../../../src/core/tool/builtin/shell/tools";

const roots: string[] = [];
const toolSets: ShellTools[] = [];

function bypassYieldTimePolicy(options: Parameters<ShellYieldTimePolicy>[0]): number {
  return options.requestedMs ?? 10_000;
}

function createTools(): ShellTools {
  const tools = createShellTools({ yieldTimePolicy: bypassYieldTimePolicy });
  toolSets.push(tools);
  return tools;
}

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

afterEach(async () => {
  await Promise.all(toolSets.splice(0).map((tools) => tools.runCommand.dispose?.()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-agent-shell-"));
  roots.push(root);
  return root;
}

async function execute(
  tools: ShellTools,
  input: Parameters<ShellTools["runCommand"]["handler"]>[0],
  root: string | null,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return executeToolCall(tools.runCommand, input, context(root, signal));
}

async function executeWrite(
  tools: ShellTools,
  input: Parameters<ShellTools["writeStdin"]["handler"]>[0],
  root: string | null,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return executeToolCall(tools.writeStdin, input, context(root, signal));
}

function modelText(result: ToolResult): string {
  if (!result.success) throw new Error(result.error.message);
  return result.modelContent;
}

function nodeCommand(scriptPath: string): string {
  if (process.platform === "win32")
    return `& ${quotePowerShell(process.execPath)} ${quotePowerShell(scriptPath)}`;
  return `${quotePosix(process.execPath)} ${quotePosix(scriptPath)}`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(filePath))) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 父进程启动一个孙进程，孙进程延迟写 marker；父进程写 started 后常驻。
 * 超时/取消后 marker 仍出现，说明只杀了根进程而没有收割进程树。
 */
async function writeProcessTree(
  workspace: string,
): Promise<{ command: string; started: string; marker: string }> {
  const started = path.join(workspace, "started.txt");
  const marker = path.join(workspace, "leaked.txt");
  const child = path.join(workspace, "child.cjs");
  const parent = path.join(workspace, "parent.cjs");
  await fs.writeFile(
    child,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 2_500)`,
  );
  await fs.writeFile(
    parent,
    [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(started)}, 'started')`,
      "setTimeout(() => {}, 5_000)",
    ].join("\n"),
  );
  return { command: nodeCommand(parent), started, marker };
}

describe("RunCommand", { timeout: 30_000 }, () => {
  it("reports a successful empty output with exit code 0", async () => {
    const root = await createRoot();
    const tools = createTools();
    const command = process.platform === "win32" ? "Get-ChildItem -Path . -Force" : "true";
    const result = await execute(tools, { command }, root);

    expect(modelText(result)).toContain("Command completed successfully with no output.");
    expect(modelText(result)).toContain("Exit code: 0");
  });

  it("keeps variables across statements in the same shell process", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "state.txt"), "0123456789", "utf8");
    const tools = createTools();
    const command =
      process.platform === "win32"
        ? "$fi = Get-Item 'state.txt'\nWrite-Host ('Length: ' + $fi.Length)"
        : "value=$(wc -c < state.txt)\nprintf 'Length: %s' \"$value\"";
    const result = await execute(tools, { command }, root);

    expect(modelText(result)).toContain("Length: 10");
  });

  it("returns the non-zero exit code of a failed command", async () => {
    const root = await createRoot();
    const tools = createTools();
    const command = process.platform === "win32" ? "cmd /c exit 7" : "sh -c 'exit 7'";
    const result = await execute(tools, { command }, root);

    expect(modelText(result)).toContain("Exit code: 7");
  });

  it("returns UTF-8 output", async () => {
    const root = await createRoot();
    const tools = createTools();
    const command = process.platform === "win32" ? 'Write-Output "中文输出"' : "printf '中文输出'";
    const result = await execute(tools, { command }, root);

    expect(modelText(result)).toContain("中文输出");
  });

  it("runs in a workspace-relative or absolute workdir", async () => {
    const root = await createRoot();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "marker.txt"), "nested-marker", "utf8");
    const tools = createTools();
    const command = process.platform === "win32" ? "Get-Content marker.txt" : "cat marker.txt";

    expect(modelText(await execute(tools, { command, workdir: "nested" }, root))).toContain(
      "nested-marker",
    );
    expect(modelText(await execute(tools, { command, workdir: nested }, root))).toContain(
      "nested-marker",
    );
  });

  it("rejects a missing workdir and a workdir that is not a directory", async () => {
    const root = await createRoot();
    await fs.writeFile(path.join(root, "file.txt"), "file", "utf8");
    const tools = createTools();

    const missing = await execute(tools, { command: "echo no", workdir: "missing" }, root);
    expect(missing).toMatchObject({
      success: false,
      error: { code: "invalid-input" },
    });
    const notDirectory = await execute(tools, { command: "echo no", workdir: "file.txt" }, root);
    expect(notDirectory).toMatchObject({
      success: false,
      error: { code: "invalid-input" },
    });
  });

  it("requires a workspace or absolute workdir when no workspace is selected", async () => {
    const tools = createTools();

    const result = await execute(tools, { command: "echo no" }, null);
    expect(result).toMatchObject({
      success: false,
      error: { code: "invalid-input" },
    });
  });

  it("starts a session and continues it through WriteStdin", async () => {
    const root = await createRoot();
    const script = path.join(root, "session.mjs");
    await fs.writeFile(
      script,
      [
        "process.stdout.write('first\\n')",
        "setTimeout(() => process.stdout.write('second\\n'), 250)",
        "setTimeout(() => process.exit(0), 500)",
      ].join("\n"),
    );
    const tools = createTools();
    const started = await execute(tools, { command: nodeCommand(script), yieldTimeMs: 50 }, root);
    let snapshot = JSON.parse(modelText(started)) as ShellSessionSnapshot;
    expect(snapshot.status).toBe("running");
    const sessionId = snapshot.sessionId;
    if (!sessionId) throw new Error("运行中的会话缺少 sessionId。");

    const stdout = [snapshot.stdout];
    const deadline = Date.now() + 15_000;
    while (snapshot.status === "running") {
      if (Date.now() >= deadline) throw new Error("会话未在测试期限内完成。");
      snapshot = await tools.writeStdin.handler({ sessionId, yieldTimeMs: 1_000 }, context(root));
      stdout.push(snapshot.stdout);
    }
    expect(snapshot).toMatchObject({ status: "completed", exitCode: 0 });
    const output = stdout.join("");
    expect(output.match(/first/g)).toHaveLength(1);
    expect(output.match(/second/g)).toHaveLength(1);
  });

  it("turns an unknown sessionId into an invalid-input failure", async () => {
    const tools = createTools();
    const result = await executeWrite(
      tools,
      { sessionId: "unknown-session", yieldTimeMs: 1 },
      null,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "invalid-input" },
    });
  });

  it("rejects an empty or non-string command before execution", async () => {
    const tools = createTools();

    const blank = await execute(tools, { command: "   " }, null);
    const nonString = await execute(tools, { command: 42 as unknown as string }, null);

    expect(blank).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "RunCommand 的 command 必须是非空字符串" },
    });
    expect(nonString).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "RunCommand 的 command 必须是非空字符串" },
    });
  });

  it("rejects a non-string workdir before execution", async () => {
    const tools = createTools();

    const result = await execute(
      tools,
      { command: "echo hi", workdir: 42 as unknown as string },
      null,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "RunCommand 的 workdir 必须是字符串" },
    });
  });

  it("rejects an empty or non-string sessionId before execution", async () => {
    const tools = createTools();

    const blank = await executeWrite(tools, { sessionId: "   " }, null);
    const nonString = await executeWrite(tools, { sessionId: 42 as unknown as string }, null);

    expect(blank).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "WriteStdin 的 sessionId 必须是非空字符串" },
    });
    expect(nonString).toMatchObject({
      success: false,
      error: { code: "invalid-input", message: "WriteStdin 的 sessionId 必须是非空字符串" },
    });
  });

  it("truncates long output and keeps both ends", async () => {
    const root = await createRoot();
    const script = path.join(root, "long.mjs");
    await fs.writeFile(script, "process.stdout.write('start-' + 'x'.repeat(5000) + '-end')");
    const tools = createTools();
    const result = await execute(
      tools,
      { command: nodeCommand(script), maxOutputLength: 120 },
      root,
    );

    expect(modelText(result)).toContain("start-");
    expect(modelText(result)).toContain("-end");
    expect(modelText(result)).toContain("output truncated");
  });

  it("terminates the whole process tree on timeout", async () => {
    const root = await createRoot();
    const { command, started, marker } = await writeProcessTree(root);
    const tools = createTools();
    const result = await execute(tools, { command, timeoutMs: 1_000 }, root);

    expect(modelText(result)).toContain("Command timed out");
    await waitForPath(started);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await pathExists(marker)).toBe(false);
  }, 10_000);

  it("terminates the whole process tree when the run is cancelled", async () => {
    const root = await createRoot();
    const { command, started, marker } = await writeProcessTree(root);
    const tools = createTools();
    const controller = new AbortController();
    const pending = execute(tools, { command }, root, controller.signal);
    await waitForPath(started);
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ success: false, error: { code: "aborted" } });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await pathExists(marker)).toBe(false);
  }, 10_000);

  it("cleans the PowerShell error wrapper without losing the message", async () => {
    if (process.platform !== "win32") return;
    const root = await createRoot();
    const tools = createTools();
    const result = await execute(tools, { command: 'Write-Error "中文错误"' }, root);
    const text = modelText(result);

    expect(text).toContain("中文错误");
    expect(text).not.toContain("\uFFFD");
    expect(text).not.toMatch(/CategoryInfo|FullyQualifiedErrorId|\[Console\]::|所在位置|At line:/);
  });
});
