/** 描述静态注册的 Agent 输入、模型路由和模型请求准备；不包含领域存储或 IPC DTO。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { ModelMessage, streamText, ToolSet } from "ai";

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

/** 一次 Bot 交接的结构化控制结果；不包含用户可见回复正文。 */
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
  prepareStep?: (input: {
    stepNumber: number;
    messages: ModelMessage[];
  }) => { toolChoice?: "none"; messages?: ModelMessage[] } | undefined;
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
  /** 默认每次准备都追加当前时间；一次性答题等无需时间事实的定义显式设为 false。 */
  readonly currentTimeContext?: boolean;
  prepare(
    input: Input,
    signal: AbortSignal,
    emitter?: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
  /** 可选：Step 正常结束后产出交接控制结果；未声明时视为普通回复。 */
  result?(input: Input, stepId: string): Promise<BotTurnResult | undefined>;
}

export interface AgentExecutor<Input> {
  /** 只读模型请求投影；不创建会话运行、不写事件、不执行工具。 */
  prepare(
    input: Input,
    signal: AbortSignal,
    emitter?: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
  /** 只解析正常结束后的结构化结果；不启动会话运行、不写事件。 */
  result?(input: Input, stepId: string): Promise<BotTurnResult | undefined>;
}

export type AgentModelRoutes = Readonly<Record<AgentModelRoute, ConversationCapabilityEndpoint>>;
