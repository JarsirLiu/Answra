import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AgentCommand,
  AgentFrame,
  AgentHost,
  AgentTransport,
  RecognizerSource,
  SkillRoots,
  TenVadSource,
} from "@answra/agent";
import { SqliteConversationStore, SqliteSessionJournal, startAgentHost } from "@answra/agent";
import { createParaformerRecognizerModule } from "../interview/asrRecognizer";
import { createTenVadFileSource } from "../interview/tenVadResources";

/** Adapts Electron's utility-process message port to the platform-neutral Agent host. */
export interface AgentWorkerOptions {
  /** 由 AgentService 解析的预编译 VAD 资源目录（resources/vad）。 */
  vadResourceRoot?: string;
  /** 由 AgentService 解析的本地 ASR 模型资源目录（resources/asr）。 */
  asrResourceRoot?: string;
  /** 桌面会话历史根目录；缺省使用内存 store。 */
  sessionsRoot?: string;
  /** 由 AgentService 解析的内置 skill 目录（resources/skills）。 */
  builtinSkillsRoot?: string;
  /** 由 AgentService 解析的用户级 skill 目录（~/.answra/skills）。 */
  userSkillsRoot?: string;
  /** 用户级 AGENTS.md 路径；缺省只加载工作区。 */
  globalInstructionFile?: string;
  /** 测试注入：绕过从磁盘加载预编译资源。 */
  vad?: TenVadSource;
  /** 测试注入：绕过从磁盘加载本地模型。 */
  recognizer?: RecognizerSource;
}

export function startAgentWorker(
  parentPort: Electron.ParentPort,
  options?: AgentWorkerOptions,
): AgentHost {
  const transport: AgentTransport = {
    send: (frame: AgentFrame) => parentPort.postMessage(frame),
    onCommand: (listener) =>
      parentPort.on("message", ({ data }: Electron.MessageEvent) => {
        listener(data as AgentCommand);
      }),
    close: () => process.exit(0),
  };

  const vad =
    options?.vad ??
    // 缺省路径时文件源会在加载阶段以显式错误失败（fail-closed），而不是假装可用。
    createTenVadFileSource(options?.vadResourceRoot ?? "");
  const recognizer = createRecognizer(options?.recognizer, options?.asrResourceRoot ?? "");
  const grepWorkerPath =
    typeof __dirname === "string" ? path.join(__dirname, "grepWorker.cjs") : undefined;
  const sessionStore =
    options?.sessionsRoot === undefined
      ? undefined
      : new SqliteConversationStore(options.sessionsRoot);
  const skillRoots = resolveSkillRoots(options);
  const sessionJournal =
    options?.sessionsRoot === undefined
      ? undefined
      : new SqliteSessionJournal(options.sessionsRoot);
  return startAgentHost({
    transport,
    vad,
    recognizer,
    ...(sessionStore ? { store: sessionStore, catalog: sessionStore } : {}),
    ...(sessionJournal ? { sessionJournal } : {}),
    ...(grepWorkerPath && existsSync(grepWorkerPath) ? { grepWorkerPath } : {}),
    ...(skillRoots ? { skillRoots } : {}),
    ...(options?.globalInstructionFile
      ? { globalInstructionFile: options.globalInstructionFile }
      : {}),
  });
}

/**
 * 内置与用户级 skill 目录：存在才注入，缺失即为"该来源没有 skill"。
 * 工作区来源由 workspace-context 命令下发，这里不解析。
 */
function resolveSkillRoots(options: AgentWorkerOptions | undefined): SkillRoots | undefined {
  const builtin = existingDirectory(options?.builtinSkillsRoot);
  const user = existingDirectory(options?.userSkillsRoot);
  if (!builtin && !user) return undefined;
  return { builtin, user, workspace: null };
}

function existingDirectory(candidate: string | undefined): string | null {
  return candidate && existsSync(candidate) ? candidate : null;
}

function createRecognizer(
  injected: RecognizerSource | undefined,
  asrResourceRoot: string,
): RecognizerSource {
  if (injected) return injected;
  return {
    // 缺省路径时装配在加载阶段以显式错误失败（fail-closed），而不是假装可用。
    load: async () => {
      const setup = await createParaformerRecognizerModule(asrResourceRoot);
      return { module: setup.module, recipe: setup.recipe };
    },
  };
}
