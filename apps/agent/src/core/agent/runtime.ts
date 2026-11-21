/** 静态 Agent 注册、模型路由、run 取消/等待和 Execution 查询的稳定运行时入口。 */
import { randomUUID } from "node:crypto";
import type { AgentEventEnvelope, AgentRunSnapshot, RunOutcome } from "@answra/shared/schema";
import type { ExecutionStore } from "../../execution/store";
import { generateModelText } from "../model/modelTransport";
import { validateEndpoint } from "../model/providerFetch";
import { RunRegistry } from "../run/registry";
import { withCurrentTimeContext } from "./currentTimeContext";
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
  private readonly internalSessionId = randomUUID();
  private shuttingDown = false;
  private routes?: AgentModelRoutes;

  constructor({ executionStore, emitEvent, tokenProvider }: AgentRuntimeOptions) {
    this.executionStore = executionStore;
    this.tokenProvider = tokenProvider;
    this.unsubscribeEvents = executionStore.subscribe(emitEvent);
  }

  registerAgent<Input>(definition: AgentDefinition<Input>): AgentExecutor<Input> {
    const agent = withCurrentTimeContext(definition);
    const result = agent.result;
    this.agentRegistry.register(agent.id);
    return {
      startRun: (request) => this.startRun(agent, request),
      prepare: (input, signal, emitter) => agent.prepare(input, signal, emitter),
      ...(result ? { result: (input: Input, runId: string) => result(input, runId) } : {}),
    };
  }

  /** 启动期校验目录里的每个 Bot 都有对应的执行注册。 */
  assertRegistered(ids: readonly AgentId[]): void {
    for (const id of ids) this.agentRegistry.require(id);
  }

  /** 启动期校验团队入口与成员都已注册。 */
  assertTeamMembers(entryAgentId: AgentId, memberAgentIds: readonly AgentId[]): void {
    this.agentRegistry.assertTeamMembers(entryAgentId, memberAgentIds);
  }

  configureModelRoutes(routes: AgentModelRoutes): void {
    validateEndpoint(routes.chat);
    validateEndpoint(routes.answer);
    this.routes = {
      chat: { ...routes.chat },
      answer: { ...routes.answer },
    };
  }

  /** 当前 chat 端点的非 secret 上下文窗口；未声明时由领域使用内部保守预算。 */
  chatContextWindow(): number | undefined {
    return this.routes?.chat.contextWindow;
  }

  /** 内部文本任务（上下文摘要等）：复用鉴权与重试，但不注册 Agent、不产生 run 事件。 */
  async generateText({
    prompt,
    accessToken,
    signal,
  }: {
    prompt: string;
    accessToken: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const endpoint = this.requireRoutes().chat;
    return generateModelText({
      transport: {
        endpoint,
        accessToken,
        conversationId: this.internalSessionId,
        ...(this.tokenProvider === undefined ? {} : { tokenProvider: this.tokenProvider }),
      },
      prompt,
      ...(signal === undefined ? {} : { signal }),
    });
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

  /** 宿主退出：先取消并等待所有 run 的最终消息落账，再释放事件订阅。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.runs.abortAllAndWait();
    this.unsubscribeEvents();
  }

  dispose(): void {
    this.shuttingDown = true;
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
    if (this.shuttingDown) throw new Error("Agent 运行时正在关闭");
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
    if (this.shuttingDown) {
      this.runs.finish(runId);
      throw new Error("Agent 运行时正在关闭");
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
    const result = done.then((outcome) =>
      outcome === "completed" && definition.result
        ? definition.result(setup.input, runId)
        : undefined,
    );
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

    return { runId, eventRevision, prepared: setup.prepared, result, done };
  }

  private requireRoutes(): AgentModelRoutes {
    if (!this.routes) throw new Error("云端模型服务尚未就绪");
    return this.routes;
  }
}
