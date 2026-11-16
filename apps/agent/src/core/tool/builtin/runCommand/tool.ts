/**
 * RunCommand 工具定义：一次性命令与可续接 shell 会话共用同一个模型契约。
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
import { RUN_COMMAND_TOOL_NAME } from "../../names";
import { buildRunCommandDescription } from "./environment";
import { LocalShell, type ShellOutputResult } from "./process/oneShot";
import {
  ShellSessionManager,
  ShellSessionNotFoundError,
  type ShellSessionSnapshot,
  type ShellYieldTimePolicy,
} from "./process/sessions";
import { resolveShellWorkdir } from "./process/workdir";
import { resolveShellRuntime } from "./shell/runtime";

// Windows CreateProcess 的命令行上限约 32K；留出解释器前缀与转义余量。
const MAX_COMMAND_CHARS = process.platform === "win32" ? 30_000 : 64_000;
const MAX_STDIN_CHARS = 64_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_YIELD_TIME_MS = 300_000;
const MAX_OUTPUT_LENGTH = 100_000;
// 投影前允许的分段输出上限；最终模型内容再由 resultBudget 截到 20k。
const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;
const MODEL_OUTPUT_BUDGET = 20_000;
const RUN_COMMAND_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS + 30_000;

interface RunCommandInput {
  command?: string;
  sessionId?: string;
  chars?: string;
  workdir?: string;
  timeoutMs?: number;
  maxOutputLength?: number;
  yieldTimeMs?: number;
}

type RunCommandOutput =
  | { readonly kind: "result"; readonly result: ShellOutputResult }
  | { readonly kind: "session"; readonly snapshot: ShellSessionSnapshot };

const RUN_COMMAND_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      maxLength: MAX_COMMAND_CHARS,
      description:
        "Complete shell script in one string; required when sessionId is omitted. Statements run in the same shell process.",
    },
    sessionId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "Session ID returned by RunCommand. Continue that session instead of starting a new command.",
    },
    chars: {
      type: "string",
      maxLength: MAX_STDIN_CHARS,
      description: "Text to write to the session stdin before waiting. Requires sessionId.",
    },
    workdir: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "Working directory, relative to the workspace root or absolute. Only valid when starting a command.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: MAX_COMMAND_TIMEOUT_MS,
      description:
        "Total process timeout in milliseconds. Only valid when starting a command; sessions have no default timeout.",
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
        "Foreground wait time. If a started command is still running, returns a sessionId for a later RunCommand call.",
    },
  },
  anyOf: [{ required: ["command"] }, { required: ["sessionId"] }],
  additionalProperties: false,
};

export interface ShellTools {
  readonly runCommand: ToolEntry<RunCommandInput, RunCommandOutput>;
}

export interface ShellToolsOptions {
  readonly yieldTimePolicy?: ShellYieldTimePolicy;
}

/** 创建 shell 工具；会话管理器和 dispose 都挂在 RunCommand 上。 */
export function createShellTools(options: ShellToolsOptions = {}): ShellTools {
  const shell = new LocalShell();
  const runtime = resolveShellRuntime();
  const sessions = new ShellSessionManager({
    ...(options.yieldTimePolicy ? { yieldTimePolicy: options.yieldTimePolicy } : {}),
  });

  return {
    runCommand: defineTool<RunCommandInput, RunCommandOutput>({
      id: toolId("workspace.run-command"),
      metadata: {
        name: RUN_COMMAND_TOOL_NAME,
        description: buildRunCommandDescription(runtime),
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
      exposeOutput: true,
      handler: (input, context) => executeRunCommand(input, context, shell, sessions),
      validateInput: validateRunCommandInput,
      formatModelContent: formatRunCommandOutput,
      dispose: () => sessions.cleanup(),
    }),
  };
}

async function executeRunCommand(
  input: RunCommandInput,
  context: ToolContext,
  shell: LocalShell,
  sessions: ShellSessionManager,
): Promise<RunCommandOutput> {
  try {
    if (input.sessionId !== undefined) {
      const snapshot = await sessions.writeStdin({
        sessionId: input.sessionId,
        ...(input.chars !== undefined && { chars: input.chars }),
        ...(input.yieldTimeMs !== undefined && { yieldTimeMs: input.yieldTimeMs }),
        ...(input.maxOutputLength !== undefined && { maxOutputLength: input.maxOutputLength }),
        signal: context.signal,
      });
      return { kind: "session", snapshot };
    }

    if (input.command === undefined) {
      throw new ToolExecutionError("invalid-input", "RunCommand 需要 command 或 sessionId");
    }
    const cwd = await resolveShellWorkdir(context.workspaceRoot, input.workdir);
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
  if (!isRecord(input)) {
    return { ok: false, code: "invalid-input", message: "RunCommand 参数必须是对象" };
  }
  const hasCommand = input.command !== undefined;
  const hasSession = input.sessionId !== undefined;
  if (hasCommand === hasSession) {
    return {
      ok: false,
      code: "invalid-input",
      message: "RunCommand 必须且只能提供 command 或 sessionId",
    };
  }

  if (hasSession) {
    if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      return {
        ok: false,
        code: "invalid-input",
        message: "RunCommand 的 sessionId 必须是非空字符串",
      };
    }
    if (input.chars !== undefined && typeof input.chars !== "string") {
      return { ok: false, code: "invalid-input", message: "RunCommand 的 chars 必须是字符串" };
    }
    if (input.workdir !== undefined) {
      return {
        ok: false,
        code: "invalid-input",
        message: "RunCommand 的 workdir 只用于启动新命令，不能和 sessionId 同时使用",
      };
    }
    if (input.timeoutMs !== undefined) {
      return {
        ok: false,
        code: "invalid-input",
        message: "RunCommand 的 timeoutMs 只用于启动新命令，不能和 sessionId 同时使用",
      };
    }
    return undefined;
  }

  if (typeof input.command !== "string" || !input.command.trim()) {
    return { ok: false, code: "invalid-input", message: "RunCommand 的 command 必须是非空字符串" };
  }
  if (input.chars !== undefined) {
    return {
      ok: false,
      code: "invalid-input",
      message: "RunCommand 的 chars 只用于续接 sessionId",
    };
  }
  if (input.workdir !== undefined && typeof input.workdir !== "string") {
    return { ok: false, code: "invalid-input", message: "RunCommand 的 workdir 必须是字符串" };
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
