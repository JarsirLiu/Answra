/** 描述静态注册的 Agent 输入、模型路由和模型请求准备；不包含领域存储或 IPC DTO。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { AgentEventEnvelope, RunOutcome } from "@answra/shared/schema";
import type { ModelMessage, PrepareStepFunction, StopCondition, streamText, ToolSet } from "ai";

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

/** Bot 的稳定身份；注册期校验和模型目录都读取这一份。 */
export interface BotIdentity {
  /** 展示名，例如“面试向导”。 */
  name: string;
  /** 稳定角色名，例如 "intake"。 */
  role: string;
  /** 给其他 Bot 和用户看的职责说明。 */
  responsibility: string;
  /** 职责拥有的领域标签，用于交接目标匹配。 */
  owns: readonly string[];
}

export type BotVisibility =
  | { kind: "team"; teamId: string }
  | { kind: "bots"; agentIds: readonly AgentId[] };

/** 一个 Bot 能被谁发现；发现 ACL 同时是交接目标授权。 */
export interface BotDiscovery {
  visibleTo: BotVisibility;
}

/** 一次 run 的结构化控制结果；不包含用户可见回复正文。 */
export interface BotTurnResult {
  kind: "handoff";
  /** 目标 Bot；必须出现在当前 Bot 的可见目录中。 */
  to: AgentId;
  /** 给目标 Bot 的交接说明；在目标视角是一条 user 消息。 */
  task: string;
}

export interface AgentModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  prepareStep?: PrepareStepFunction<ToolSet>;
  temperature?: number;
  providerOptions?: ProviderOptions;
}

export interface AgentToolOutputEmitter {
  /** 单次工具调用在结束前产生的增量输出；由 Agent 层负责排序与写入。 */
  toolOutput(toolCallId: string, delta: string): void;
}

export interface AgentDefinition<Input> {
  readonly id: AgentId;
  readonly identity: BotIdentity;
  readonly discovery: BotDiscovery;
  readonly modelRoute: AgentModelRoute;
  prepare(
    input: Input,
    signal: AbortSignal,
    emitter?: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
  /** 可选：run 正常结束后产出交接控制结果；未声明时视为普通回复。 */
  result?(input: Input, runId: string): Promise<BotTurnResult | undefined>;
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
  /** 当前 run 的结构化回合结果；未声明或未正常完成时为 undefined。 */
  result: Promise<BotTurnResult | undefined>;
  done: Promise<RunOutcome>;
}

export interface AgentExecutor<Input> {
  startRun<Prepared = void>(
    request: AgentRunRequest<Input, Prepared>,
  ): Promise<AgentRunHandle<Prepared>>;
}

export type AgentModelRoutes = Readonly<Record<AgentModelRoute, ConversationCapabilityEndpoint>>;
