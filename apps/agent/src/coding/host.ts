/** CLI coding host 组合根：装配 AgentRuntime、工具、coding Bot 与单 Bot 会话用例。 */
import type { ConversationSnapshot } from "@answra/shared";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import { createCodingBot } from "../bots/coding/bot";
import { AgentRuntime } from "../core/agent/runtime";
import { createInstructionLoader } from "../core/instruction";
import { SessionFrameBus } from "../core/session/sessionFrameBus";
import { createLazySkillCatalog } from "../core/skill/catalog";
import type { SkillRoots } from "../core/skill/contracts";
import { createBuiltinToolRegistry } from "../core/tool";
import type { ConversationSessionCatalog } from "../core/transcript/catalog";
import type { SessionItemStore } from "../core/transcript/itemStore";
import { MemoryConversationStore } from "../core/transcript/memoryStore";
import type { ConversationStore } from "../core/transcript/store";
import { CodingApplication } from "./application";

export interface CodingHostOptions {
  /** durable 事实帧监听；与 `sessionFrames` 二选一，宿主按需要选择消费方式。 */
  onSessionFrame?: (frame: SessionFrame) => void;
  /** live 增量帧监听；允许丢失，不参与重放。 */
  onLiveFrame?: (frame: LiveFrame) => void;
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  store?: ConversationStore;
  catalog?: ConversationSessionCatalog;
  /** durable 会话条目；CLI 宿主注入 SQLite 实现，缺省为内存实现。 */
  sessionItems?: SessionItemStore;
  /** 帧广播口；缺省在宿主内新建。CLI UI 暂不消费，供 P2 第 3 步切换。 */
  sessionFrames?: SessionFrameBus;
  workspaceRoot?: string | null;
  /** 用户级 AGENTS.md 绝对路径；缺省只加载工作区。 */
  globalInstructionFile?: string | null;
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
  /** 该宿主的帧广播口：领域只发布，订阅方决定消费方式。 */
  sessionFrames: SessionFrameBus;
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
  onSessionFrame,
  onLiveFrame,
  onSnapshot,
  tokenProvider,
  store = new MemoryConversationStore(),
  catalog,
  sessionItems,
  sessionFrames = new SessionFrameBus(),
  workspaceRoot = null,
  globalInstructionFile = null,
  grepWorkerPath,
  skillRoots,
}: CodingHostOptions): CodingHost {
  const agentRuntime = new AgentRuntime({ tokenProvider });
  const instructions = createInstructionLoader({
    globalFile: globalInstructionFile,
    onWarning: (message) => console.warn("[coding][instruction]", message),
  });
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
    instructions,
    ...(skills ? { skills } : {}),
  });
  const runtime = new CodingApplication({
    agentRuntime,
    store,
    bot,
    ...(sessionItems ? { sessionItems } : {}),
    sessionFrames,
    onSnapshot,
  });
  runtime.setWorkspaceRoot(workspaceRoot);
  const unsubscribeFrames =
    onSessionFrame === undefined && onLiveFrame === undefined
      ? undefined
      : sessionFrames.subscribe({
          ...(onSessionFrame === undefined ? {} : { onFrame: onSessionFrame }),
          ...(onLiveFrame === undefined ? {} : { onLiveFrame }),
        });

  let disposed = false;
  let shutdownPromise: Promise<void> | undefined;
  return {
    runtime,
    ...(catalog ? { catalog } : {}),
    sessionFrames,
    async setWorkspaceRoot(nextWorkspaceRoot: string | null) {
      runtime.setWorkspaceRoot(nextWorkspaceRoot);
      // 结果迟到由 catalog 自身按 generation 丢弃。
      await skillsReady?.setWorkspaceRoot(nextWorkspaceRoot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFrames?.();
      runtime.dispose();
      skillsReady?.dispose();
      void tools.dispose().catch((error: unknown) => {
        console.warn("[coding] tool cleanup failed", error);
      });
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        await runtime.shutdown();
        await agentRuntime.shutdown();
        disposed = true;
        unsubscribeFrames?.();
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
