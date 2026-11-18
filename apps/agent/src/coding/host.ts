/** CLI coding host 组合根：装配 AgentRuntime、工具、coding Bot 与单 Bot 会话用例。 */
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { AgentRuntime } from "../core/agent/runtime";
import { createLazySkillCatalog } from "../core/skill/catalog";
import type { SkillRoots } from "../core/skill/contracts";
import { createBuiltinToolRegistry } from "../core/tool";
import type { ConversationSessionCatalog } from "../core/transcript/catalog";
import { MemoryConversationStore } from "../core/transcript/memoryStore";
import type { ConversationStore } from "../core/transcript/store";
import { MemoryExecutionStore } from "../execution/memoryStore";
import type { ExecutionStore } from "../execution/store";
import { CodingApplication } from "./application";
import { createCodingBot } from "./bot";

export interface CodingHostOptions {
  emitEvent: (event: AgentEventEnvelope) => void;
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  store?: ConversationStore;
  catalog?: ConversationSessionCatalog;
  executionStore?: ExecutionStore;
  workspaceRoot?: string | null;
  /** 宿主注入的 Grep WASI worker 脚本路径；缺省时在 Agent 进程内执行。 */
  grepWorkerPath?: string;
  /**
   * skill 来源根目录，由宿主解析后注入；缺省表示本会话没有可用 skill。
   * 不提供任何默认目录——不回退到猜测路径。
   */
  skillRoots?: SkillRoots;
}

export interface CodingHost {
  runtime: CodingApplication;
  catalog?: ConversationSessionCatalog;
  /**
   * 切换工作区并重扫工作区来源的 skill。
   * 工作区在 CLI 里是运行时确定的，启动时未必已知。
   */
  setWorkspaceRoot(workspaceRoot: string | null): Promise<void>;
  dispose(): void;
  /** 退出屏障：abort 活动 run、等待最终落账并关闭 store；可重复调用。 */
  shutdown(): Promise<void>;
}

export function startCodingHost({
  emitEvent,
  onSnapshot,
  tokenProvider,
  store = new MemoryConversationStore(),
  catalog,
  executionStore = new MemoryExecutionStore(),
  workspaceRoot = null,
  grepWorkerPath,
  skillRoots,
}: CodingHostOptions): CodingHost {
  const agentRuntime = new AgentRuntime({ executionStore, emitEvent, tokenProvider });
  const skillsReady = skillRoots ? createLazySkillCatalog(skillRoots) : undefined;
  const skills = skillsReady?.catalog;
  const tools = createBuiltinToolRegistry({
    ...(grepWorkerPath ? { workerPaths: { grep: grepWorkerPath } } : {}),
    ...(skills ? { skills } : {}),
  });
  const bot = createCodingBot({
    agentRuntime,
    store,
    tools,
    ...(skills ? { skills } : {}),
  });
  const runtime = new CodingApplication({ agentRuntime, store, bot, onSnapshot });
  runtime.setWorkspaceRoot(workspaceRoot);

  let disposed = false;
  let shutdownPromise: Promise<void> | undefined;
  return {
    runtime,
    ...(catalog ? { catalog } : {}),
    async setWorkspaceRoot(nextWorkspaceRoot: string | null) {
      runtime.setWorkspaceRoot(nextWorkspaceRoot);
      // 结果迟到由 catalog 自身按 generation 丢弃。
      await skillsReady?.setWorkspaceRoot(nextWorkspaceRoot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      skillsReady?.dispose();
      void tools.dispose().catch((error: unknown) => {
        console.warn("[coding] tool cleanup failed", error);
      });
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        await agentRuntime.shutdown();
        disposed = true;
        runtime.dispose();
        skillsReady?.dispose();
        await tools.dispose().catch((error: unknown) => {
          console.warn("[coding] tool cleanup failed", error);
        });
        await store.close();
      })();
      return shutdownPromise;
    },
  };
}
