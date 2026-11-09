/**
 * RunCommand / WriteStdin 工具定义：把一次性命令与可续接会话投影成模型契约。
 * 命令在 Agent 进程执行；desktop 不代执行，也不提供额外沙箱或审批。
 */

import type { JSONSchema7 } from "ai";
import {
  defineTool,
  type ToolContext,
  type ToolEntry,
  type ToolHandlerFailure,
  toolId,
} from "../../contracts";
import { ToolExecutionError } from "../../executor/result";
import { LocalShell, type ShellOutputResult } from "./localShell";
import {
  ShellSessionManager,
  ShellSessionNotFoundError,
  type ShellSessionSnapshot,
  type ShellYieldTimePolicy,
} from "./sessions";
import { resolveShellWorkdir } from "./workdir";

const MAX_COMMAND_CHARS = 64_000;
const MAX_STDIN_CHARS = 64_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_YIELD_TIME_MS = 300_000;
const MAX_OUTPUT_LENGTH = 100_000;
// 投影前允许的分段输出上限；最终模型内容再由 resultBudget 截到 20k。
const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;
const MODEL_OUTPUT_BUDGET = 20_000;
const RUN_COMMAND_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS + 30_000;
const WRITE_STDIN_TIMEOUT_MS = MAX_YIELD_TIME_MS + 10_000;

interface RunCommandInput {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputLength?: number;
  yieldTimeMs?: number;
}

interface WriteStdinInput {
  sessionId: string;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputLength?: number;
}

type RunCommandOutput =
  | { readonly kind: "result"; readonly result: ShellOutputResult }
  | { readonly kind: "session"; readonly snapshot: ShellSessionSnapshot };

const RUN_COMMAND_DESCRIPTION = [
  "Executes a shell command in the current workspace.",
  "",
  "- Windows uses PowerShell; POSIX uses `$SHELL` or `sh`.",
  "- Multiple statements run in one shell process, so variables and state persist.",
  "- Windows PowerShell: use `$LASTEXITCODE` for exit codes and `Get-Command` instead of `where`.",
  "- `workdir` may be workspace-relative or absolute; the workspace is the default cwd, not a sandbox.",
  "- A command that runs longer than `yieldTimeMs` returns a sessionId for WriteStdin.",
  "- Without `yieldTimeMs`, the command runs to completion or its process timeout.",
].join("\n");

const RUN_COMMAND_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      maxLength: MAX_COMMAND_CHARS,
      description: "Complete shell script in one string; statements run in the same shell process.",
    },
    workdir: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "Working directory, relative to the workspace root or absolute. Defaults to the workspace root.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: MAX_COMMAND_TIMEOUT_MS,
      description:
        "Total process timeout in milliseconds. One-shot commands default to 120000; sessions have no default timeout.",
    },
    maxOutputLength: {
      type: "integer",
      minimum: 1,
      maximum: MAX_OUTPUT_LENGTH,
      description: "Maximum characters returned for each output stream in this response.",
    },
    yieldTimeMs: {
      type: "integer",
      minimum: 1,
      maximum: MAX_YIELD_TIME_MS,
      description:
        "Foreground wait time. If the command is still running, returns a sessionId for WriteStdin.",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

const WRITE_STDIN_DESCRIPTION = [
  "Waits for a shell session or writes text to its stdin.",
  "",
  "- Use the sessionId returned by RunCommand.",
  "- Returns incremental stdout, stderr, and the current exit status.",
  "- A finished session keeps its final result until it is evicted.",
].join("\n");

const WRITE_STDIN_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Session ID returned by RunCommand.",
    },
    chars: {
      type: "string",
      maxLength: MAX_STDIN_CHARS,
      description: "Text to write to the session stdin before waiting.",
    },
    yieldTimeMs: {
      type: "integer",
      minimum: 1,
      maximum: MAX_YIELD_TIME_MS,
      description: "Foreground wait time before returning another incremental snapshot.",
    },
    maxOutputLength: {
      type: "integer",
      minimum: 1,
      maximum: MAX_OUTPUT_LENGTH,
      description: "Maximum characters returned for each output stream in this response.",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
};

export interface ShellTools {
  readonly runCommand: ToolEntry<RunCommandInput, RunCommandOutput>;
  readonly writeStdin: ToolEntry<WriteStdinInput, ShellSessionSnapshot>;
}

export interface ShellToolsOptions {
  readonly yieldTimePolicy?: ShellYieldTimePolicy;
}

/** 创建共享同一 session manager 的两个 shell 工具；dispose 挂在 RunCommand 上。 */
export function createShellTools(options: ShellToolsOptions = {}): ShellTools {
  const shell = new LocalShell();
  const sessions = new ShellSessionManager({
    ...(options.yieldTimePolicy ? { yieldTimePolicy: options.yieldTimePolicy } : {}),
  });

  return {
    runCommand: defineTool<RunCommandInput, RunCommandOutput>({
      id: toolId("workspace.run-command"),
      metadata: {
        name: "RunCommand",
        description: RUN_COMMAND_DESCRIPTION,
        readOnly: false,
        destructive: true,
        concurrentSafe: false,
        sideEffectScope: "process",
        timeoutMs: RUN_COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_MODEL_OUTPUT_BYTES,
        resultBudget: {
          strategy: "truncate",
          maxModelChars: MODEL_OUTPUT_BUDGET,
          maxModelBytes: MODEL_OUTPUT_BUDGET,
        },
      },
      inputSchema: RUN_COMMAND_INPUT_SCHEMA,
      handler: (input, context) => executeRunCommand(input, context, shell, sessions),
      validateInput: validateRunCommandInput,
      formatModelContent: formatRunCommandOutput,
      dispose: () => sessions.cleanup(),
    }),
    writeStdin: defineTool<WriteStdinInput, ShellSessionSnapshot>({
      id: toolId("workspace.write-stdin"),
      metadata: {
        name: "WriteStdin",
        description: WRITE_STDIN_DESCRIPTION,
        readOnly: false,
        destructive: true,
        concurrentSafe: false,
        sideEffectScope: "process",
        timeoutMs: WRITE_STDIN_TIMEOUT_MS,
        maxOutputBytes: MAX_MODEL_OUTPUT_BYTES,
        resultBudget: {
          strategy: "truncate",
          maxModelChars: MODEL_OUTPUT_BUDGET,
          maxModelBytes: MODEL_OUTPUT_BUDGET,
        },
      },
      inputSchema: WRITE_STDIN_INPUT_SCHEMA,
      handler: (input, context) => executeWriteStdin(input, context, sessions),
      validateInput: validateWriteStdinInput,
      formatModelContent: (snapshot) => JSON.stringify(snapshot),
    }),
  };
}

async function executeRunCommand(
  input: RunCommandInput,
  context: ToolContext,
  shell: LocalShell,
  sessions: ShellSessionManager,
): Promise<RunCommandOutput> {
  const cwd = await resolveShellWorkdir(context.workspaceRoot, input.workdir);
  try {
    if (input.yieldTimeMs === undefined) {
      const result = await shell.run(
        {
          command: input.command,
          cwd,
          ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
          ...(input.maxOutputLength !== undefined && {
            maxOutputLength: input.maxOutputLength,
          }),
          ...(context.onOutput ? { onOutput: context.onOutput } : {}),
        },
        context.signal,
      );
      return { kind: "result", result };
    }

    const snapshot = await sessions.start({
      command: input.command,
      cwd,
      yieldTimeMs: input.yieldTimeMs,
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      ...(input.maxOutputLength !== undefined && { maxOutputLength: input.maxOutputLength }),
      signal: context.signal,
    });
    return { kind: "session", snapshot };
  } catch (error) {
    throw mapShellError(error);
  }
}

async function executeWriteStdin(
  input: WriteStdinInput,
  context: ToolContext,
  sessions: ShellSessionManager,
): Promise<ShellSessionSnapshot> {
  try {
    return await sessions.writeStdin({
      sessionId: input.sessionId,
      ...(input.chars !== undefined && { chars: input.chars }),
      ...(input.yieldTimeMs !== undefined && { yieldTimeMs: input.yieldTimeMs }),
      ...(input.maxOutputLength !== undefined && { maxOutputLength: input.maxOutputLength }),
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof ShellSessionNotFoundError)
      throw new ToolExecutionError("invalid-input", error.message);
    throw mapShellError(error);
  }
}

function mapShellError(error: unknown): Error {
  if (error instanceof ToolExecutionError) return error;
  if (isAbortError(error)) return new ToolExecutionError("aborted", "工具调用已取消");
  if (error instanceof Error) return new ToolExecutionError("handler-failed", error.message);
  return new ToolExecutionError("handler-failed", "shell 命令执行失败");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function validateRunCommandInput(input: unknown): ToolHandlerFailure | undefined {
  if (!isRecord(input) || typeof input.command !== "string" || !input.command.trim()) {
    return { ok: false, code: "invalid-input", message: "RunCommand 的 command 必须是非空字符串" };
  }
  if (input.workdir !== undefined && typeof input.workdir !== "string")
    return { ok: false, code: "invalid-input", message: "RunCommand 的 workdir 必须是字符串" };
  return undefined;
}

function validateWriteStdinInput(input: unknown): ToolHandlerFailure | undefined {
  if (!isRecord(input) || typeof input.sessionId !== "string" || !input.sessionId.trim()) {
    return {
      ok: false,
      code: "invalid-input",
      message: "WriteStdin 的 sessionId 必须是非空字符串",
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatRunCommandOutput(output: RunCommandOutput): string {
  return output.kind === "session"
    ? JSON.stringify(output.snapshot)
    : formatShellResult(output.result);
}

function formatShellResult(result: ShellOutputResult): string {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (result.outcome.type === "timeout") {
    return [
      stdout,
      stderr,
      "Command timed out before it produced a normal exit code.\nExit code: unavailable (timeout)",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const exitCode = result.outcome.exitCode ?? 1;
  const status = `Exit code: ${exitCode}`;
  if (stdout || stderr) return [status, stdout, stderr].filter(Boolean).join("\n");
  return `Command completed successfully with no output.\n${status}`;
}
