/** 静态 Agent 注册、模型路由、run 取消/等待和 Execution 查询的稳定运行时入口。 */
import { randomUUID } from "node:crypto";
import type { AgentEventEnvelope, AgentRunSnapshot, RunOutcome } from "@answra/shared/schema";
import type { ExecutionStore } from "../../execution/store";
import { validateEndpoint } from "../model/providerFetch";
import { RunRegistry } from "../run/registry";
import type {
  AgentDefinition,
  AgentExecutor,
  AgentId,
  AgentModelRoutes,
  AgentRunHandle,
  AgentRunRequest,
} from "./definition";
import { executeRun } from "./executeRun";
import { AgentRegistry } from "./registry";

export interface AgentRuntimeOptions {
  executionStore: ExecutionStore;
  emitEvent: (event: AgentEventEnvelope) => void;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}

/** 跨领域模型执行底座。领域应用只拿到注册后的 executor，不接触 AI SDK 或 ExecutionStore。 */
export class AgentRuntime {
  private readonly agentRegistry = new AgentRegistry();
  private readonly runs = new RunRegistry();
  private readonly executionStore: ExecutionStore;
  private readonly tokenProvider?: AgentRuntimeOptions["tokenProvider"];
  private readonly unsubscribeEvents: () => void;
  private routes?: AgentModelRoutes;

  constructor({ executionStore, emitEvent, tokenProvider }: AgentRuntimeOptions) {
    this.executionStore = executionStore;
    this.tokenProvider = tokenProvider;
    this.unsubscribeEvents = executionStore.subscribe(emitEvent);
  }

  registerAgent<Input>(definition: AgentDefinition<Input>): AgentExecutor<Input> {
    this.agentRegistry.register(definition.id);
    return {
      startRun: (request) => this.startRun(definition, request),
    };
  }

  requireAgent(id: AgentId): void {
    this.agentRegistry.require(id);
  }

  configureModelRoutes(routes: AgentModelRoutes): void {
    validateEndpoint(routes.chat);
    validateEndpoint(routes.answer);
    this.routes = {
      chat: { ...routes.chat },
      answer: { ...routes.answer },
    };
  }

  cancel(runId: string): void {
    this.runs.cancel(runId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.runs.wait(runId);
  }

  getRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    return this.executionStore.getRun(runId);
  }

  getConversationRevision(conversationId: string): Promise<number> {
    return this.executionStore.getConversationRevision(conversationId);
  }

  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return this.executionStore.readEvents(conversationId, afterRevision);
  }

  readEventsForRun(runId: string): Promise<AgentEventEnvelope[]> {
    return this.executionStore.readEventsForRun(runId);
  }

  dispose(): void {
    this.runs.abortAll();
    this.unsubscribeEvents();
  }

  get activeRunCount(): number {
    return this.runs.activeCount;
  }

  private async startRun<Input, Prepared>(
    definition: AgentDefinition<Input>,
    request: AgentRunRequest<Input, Prepared>,
  ): Promise<AgentRunHandle<Prepared>> {
    this.agentRegistry.require(definition.id);
    const endpoint = this.requireRoutes()[definition.modelRoute];
    const runId = randomUUID();
    const eventRevision = await this.executionStore.getConversationRevision(request.conversationId);
    const controller = new AbortController();
    this.runs.register(runId, controller);

    let setup: { input: Input; prepared: Prepared };
    try {
      setup = await request.prepareRun({ runId, eventRevision });
    } catch (error) {
      this.runs.finish(runId);
      throw error;
    }

    const done: Promise<RunOutcome> = executeRun({
      definition,
      request,
      input: setup.input,
      runId,
      endpoint,
      executionStore: this.executionStore,
      tokenProvider: this.tokenProvider,
      controller,
    });
    void done.then(
      () => this.runs.finish(runId),
      (error: unknown) => {
        this.runs.finish(runId);
        console.error("[agent][run] execution finalization failed", {
          runId,
          error: error instanceof Error ? error.message : "未知执行错误",
        });
      },
    );

    return { runId, eventRevision, prepared: setup.prepared, done };
  }

  private requireRoutes(): AgentModelRoutes {
    if (!this.routes) throw new Error("云端模型服务尚未就绪");
    return this.routes;
  }
}
