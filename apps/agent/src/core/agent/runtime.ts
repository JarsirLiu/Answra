/** 静态 Agent 注册、模型路由与模型辅助能力的稳定运行时入口。 */
import { randomUUID } from "node:crypto";
import type { AgentModelRoutes, AgentExecutor, AgentId, AgentDefinition } from "./definition";
import { generateModelText } from "../model/modelTransport";
import { validateEndpoint } from "../model/providerFetch";
import { withCurrentTimeContext } from "./currentTimeContext";
import { AgentRegistry } from "./registry";

export interface AgentRuntimeOptions {
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}

/** 跨领域模型配置底座。领域应用只拿到注册后的 executor，不接触 AI SDK。 */
export class AgentRuntime {
  private readonly agentRegistry = new AgentRegistry();
  private readonly tokenProvider?: AgentRuntimeOptions["tokenProvider"];
  private readonly internalSessionId = randomUUID();
  private routes?: AgentModelRoutes;

  constructor({ tokenProvider }: AgentRuntimeOptions = {}) {
    this.tokenProvider = tokenProvider;
  }

  registerAgent<Input>(definition: AgentDefinition<Input>): AgentExecutor<Input> {
    const agent = withCurrentTimeContext(definition);
    const result = agent.result;
    this.agentRegistry.register(agent.id);
    return {
      prepare: (input, signal, emitter) => agent.prepare(input, signal, emitter),
      ...(result ? { result: (input: Input, stepId: string) => result(input, stepId) } : {}),
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

  /** 当前 chat 端点；Session StepRunner 用它执行单次 provider 请求。 */
  chatEndpoint(): NonNullable<AgentModelRoutes>["chat"] {
    return this.requireRoutes().chat;
  }

  /** 当前 answer 端点；一次性答题的 StepRunner 用它执行单次 provider 请求。 */
  answerEndpoint(): NonNullable<AgentModelRoutes>["answer"] {
    return this.requireRoutes().answer;
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

  /** 暴露反向令牌刷新端口，供 Session StepRunner 的 provider 请求复用。 */
  modelTokenProvider(): AgentRuntimeOptions["tokenProvider"] {
    return this.tokenProvider;
  }

  /** 保留宿主退出的统一调用点；会话收尾由各领域的 SessionRuntime 负责。 */
  async shutdown(): Promise<void> {}

  dispose(): void {}

  private requireRoutes(): AgentModelRoutes {
    if (!this.routes) throw new Error("云端模型服务尚未就绪");
    return this.routes;
  }
}
