/** 描述静态注册的 Agent 输入、模型路由和模型请求准备；不包含领域存储或 IPC DTO。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { AgentEventEnvelope, RunOutcome } from "@answra/shared/schema";
import type { ModelMessage, StopCondition, streamText, ToolSet } from "ai";

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

declare const agentIdBrand: unique symbol;
export type AgentId = string & { readonly [agentIdBrand]: true };

/** 只供 Agent 模块创建静态 ID；renderer 输入不经过该工厂。 */
export function agentId(value: string): AgentId {
  if (!value.trim()) throw new Error("Agent ID 不能为空");
  return value as AgentId;
}

/** 模型端点由宿主配置；Agent 定义只能选择已配置的能力路由。 */
export type AgentModelRoute = "chat" | "answer";

export interface AgentModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  temperature?: number;
  providerOptions?: ProviderOptions;
}

export interface AgentDefinition<Input> {
  readonly id: AgentId;
  readonly modelRoute: AgentModelRoute;
  prepare(input: Input, signal: AbortSignal): Promise<AgentModelRequest>;
}

export interface AgentRunPrepared {
  runId: string;
  /** Conversation event revision immediately before this run emits its first event. */
  eventRevision: number;
}

export interface AgentRunRequest<Input, Prepared> {
  conversationId: string;
  getAccessToken: () => Promise<string>;
  /** Builds domain state and model input before the first AgentEvent is appended. */
  prepareRun: (run: AgentRunPrepared) => Promise<{ input: Input; prepared: Prepared }>;
  /** Called in event order after each envelope is appended to ExecutionStore. */
  onEvent: (event: AgentEventEnvelope) => Promise<void>;
}

export interface AgentRunHandle<Prepared = void> {
  runId: string;
  eventRevision: number;
  prepared: Prepared;
  done: Promise<RunOutcome>;
}

export interface AgentExecutor<Input> {
  startRun<Prepared = void>(
    request: AgentRunRequest<Input, Prepared>,
  ): Promise<AgentRunHandle<Prepared>>;
}

export type AgentModelRoutes = Readonly<Record<AgentModelRoute, ConversationCapabilityEndpoint>>;
