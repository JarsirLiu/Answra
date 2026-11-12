/** CLI coding host 组合根：装配 AgentRuntime、工具、coding Bot 与单 Bot 会话用例。 */
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { AgentRuntime } from "../core/agent/runtime";
import { createBuiltinToolRegistry } from "../core/tool";
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
  executionStore?: ExecutionStore;
  workspaceRoot?: string | null;
  /** 宿主注入的 Grep WASI worker 脚本路径；缺省时在 Agent 进程内执行。 */
  grepWorkerPath?: string;
}

export interface CodingHost {
  runtime: CodingApplication;
  dispose(): void;
}

export function startCodingHost({
  emitEvent,
  onSnapshot,
  tokenProvider,
  store = new MemoryConversationStore(),
  executionStore = new MemoryExecutionStore(),
  workspaceRoot = null,
  grepWorkerPath,
}: CodingHostOptions): CodingHost {
  const agentRuntime = new AgentRuntime({ executionStore, emitEvent, tokenProvider });
  const tools = createBuiltinToolRegistry({
    ...(grepWorkerPath ? { workerPaths: { grep: grepWorkerPath } } : {}),
  });
  const bot = createCodingBot({ agentRuntime, store, tools });
  const runtime = new CodingApplication({ agentRuntime, store, bot, onSnapshot });
  runtime.setWorkspaceRoot(workspaceRoot);

  let disposed = false;
  return {
    runtime,
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      void tools.dispose().catch((error: unknown) => {
        console.warn("[coding] tool cleanup failed", error);
      });
    },
  };
}
