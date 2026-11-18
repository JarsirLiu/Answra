import type {
  AgentEventEnvelope,
  BotSummary,
  ConversationSessionPage,
  ConversationSessionScope,
  ConversationSnapshot,
  ManualCompactionResult,
} from "../schema";

export type {
  AgentEventEnvelope,
  ContextCompactionStatus,
  ConversationMessage,
  ConversationSessionPage,
  ConversationSessionScope,
  ConversationSessionSummary,
  ConversationSnapshot,
} from "../schema";

/** 对话运行、模型设置与会话快照的 IPC 频道和载荷契约。 */
export const ConversationChannels = {
  Send: "answra:conversation:send",
  WaitQueue: "answra:conversation:wait-queue",
  QueuePosition: "answra:conversation:queue-position",
  AppendUserMessage: "answra:conversation:append-user-message",
  Cancel: "answra:conversation:cancel",
  GetSnapshot: "answra:conversation:get-snapshot",
  Create: "answra:conversation:create",
  ReadEvents: "answra:conversation:read-events",
  /** 读取模型来源与本地端点摘要（不含 API Key）。 */
  GetConfig: "answra:conversation:get-config",
  /** 切换模型来源并保存本地端点；Key 留空表示沿用已保存的值。 */
  Configure: "answra:conversation:configure",
  /** 仅在用户点开明文时读取本机保存的 API Key。 */
  GetApiKey: "answra:conversation:get-api-key",
  /** 清除本地端点与 Key，恢复云端订阅。 */
  ClearConfig: "answra:conversation:clear-config",
  /** 清空会话消息（仅空闲会话生效；发布 snapshot change 通知所有订阅方）。 */
  ClearMessages: "answra:conversation:clear-messages",
  /** 手动压缩上下文（仅空闲且队列为空的会话生效）。 */
  Compact: "answra:conversation:compact",
  /** 列出可用于新建会话的 Bot（只含身份，不含 prompt/工具）。 */
  ListBots: "answra:conversation:list-bots",
  /** 列出已落盘的会话摘要；按 scope 隔离，不返回消息正文。 */
  ListSessions: "answra:conversation:list-sessions",
  /** 删除一个已落盘会话；活动 run 中的会话拒绝删除。 */
  DeleteSession: "answra:conversation:delete-session",
  Event: "answra:conversation:event",
  /** Pushes the authoritative transcript snapshot after an Agent-owned transcript write. */
  SnapshotChanged: "answra:conversation:snapshot-changed",
} as const;

/**
 * 「调用模型需要登录」的统一失败码。
 *
 * 两条来源都用同一个码：main 调用边界的前置门禁（未登录直接拒绝），以及云端返回 401
 * （网关 `error.code=unauthorized`，由 agent 的 fetch 包装器转成这个码）。渲染层只按码
 * 决定是否提示登录，不解析错误文案：同一类失败必须只有一个判定来源。
 */
export const AUTH_REQUIRED_CODE = "auth-required";

/** 未登录调用模型时的用户可见文案；对话与截图答题共用同一句（同一失败同一提示）。 */
export const AUTH_REQUIRED_NOTICE = "请先登录后再使用（设置 → 账户）";

/**
 * 识别任意层抛上来的错误（含 Electron IPC 重新包装后的 Error）是否表示「需要登录」。
 * 也接受裸字符串：流式 error chunk 与状态里保存的都是错误文案本身。
 */
export function isAuthRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return message.includes(AUTH_REQUIRED_CODE);
}

/** 构造带失败码的「需要登录」错误，供 main 侧门禁抛出。 */
export function authRequiredError(): Error {
  return new Error(`${AUTH_REQUIRED_CODE}: ${AUTH_REQUIRED_NOTICE}`);
}

/**
/**
 * 云端能力 ID（跨仓库契约，与网关 `internal/domain/desktop_capability.go` 同值）。
 *
 * 客户端把能力 ID 作为占位 `model` 下发，网关再改写为自己的稳定上游别名：
 * 因此模型改名、换供应商都不需要发布客户端，客户端也永远不感知真实模型名。
 */
export const DesktopCapability = {
  /** 对话补全。 */
  TextChat: "text.chat",
  /** 截图答题。 */
  ImageAnswer: "image.answer",
} as const;

/**
 * 一项云端能力的调用信息，全部由服务端下发（`GET /api/v1/capabilities` 的 `endpoints[]`）：
 * `baseUrl` 由云端 origin 与服务端声明的 path 拼出，`model` 是服务端声明的占位模型。
 * 客户端不硬编码路径与模型名，只按能力 ID 取用。
 */
export interface ConversationCapabilityEndpoint {
  baseUrl: string;
  model: string;
  /**
   * 凭据来源：`cloud` 使用账号令牌并在 401 时刷新重试；`local` 使用本机保存的
   * API Key，不触发登录、不刷新令牌。缺省按 `cloud` 处理。
   */
  auth?: "cloud" | "local";
  /**
   * provider 级非 secret 请求头；由端点配置显式提供，例如客户端 User-Agent。
   * 凭据仍只走 `auth` 对应的令牌或 API Key，不进入这里。
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * 请求级会话头名称；声明后每次 run 用 conversationId 填充该头。
   * 仅用于供应商要求的会话标识，不参与鉴权。
   */
  sessionHeader?: string;
  /**
   * 模型总上下文窗口；由服务端能力目录或端点元数据提供，非 secret。
   * 缺省时使用内部保守预算，不向用户暴露手动配置。
   */
  contextWindow?: number;
  /**
   * 厂商扩展请求参数（非 secret），由本地 `config.json` 的 `answer.providerOptions`
   * 注入，例如 MiMo 的 `thinking` 或 Qwen 的 `enable_thinking` / `thinking_budget`。
   * Agent 按原样并入请求体；只允许配置明确支持这些字段的模型，客户端不做兼容性猜测。
   */
  providerOptions?: Readonly<Record<string, unknown>>;
}

/**
 * agent 运行时的模型配置：两项云端能力各自的端点。
 *
 * 不再包含任何用户凭据——访问令牌按次运行注入（见 `AgentCommand` 的 `accessToken`），
 * 不落盘、不进 renderer，也不作为配置的一部分被保存。
 */
export interface ConversationModelConfig {
  /** 对话能力（`DesktopCapability.TextChat`）。 */
  chat: ConversationCapabilityEndpoint;
  /** 截图答题能力（`DesktopCapability.ImageAnswer`）。 */
  answer: ConversationCapabilityEndpoint;
}

/**
 * 模型调用来源：`local` 走本机保存的自定义端点（OpenAI 兼容），`cloud` 走云端订阅。
 *
 * 这是显式切换，不是优先级兜底：选哪一路就只用哪一路。本地来源在开发态和
 * answer 打包版可选；full 打包版固定云端，避免绕过订阅。
 */
export type ConversationModelSource = "local" | "cloud";

/** 保存给主进程的模型设置；`apiKey` 留空表示沿用已保存的 Key。 */
export interface ConversationModelSettings {
  source: ConversationModelSource;
  /** OpenAI 兼容地址，如 `http://127.0.0.1:1234/v1`。 */
  baseUrl: string;
  /** 对话模型 ID。 */
  model: string;
  /** 截图答题模型 ID；留空沿用 `model`。 */
  answerModel?: string;
  /** 本地端点的 API Key；留空表示沿用已保存的值。 */
  apiKey?: string;
}

/** 渲染层可见的模型设置摘要（不含任何凭据）。 */
export interface ConversationModelSettingsView {
  source: ConversationModelSource;
  /** 是否允许选择本地来源（开发态或 answer 打包版为 true）。 */
  localAvailable: boolean;
  baseUrl: string;
  model: string;
  answerModel: string;
  /** 本地端点是否已配置可用。 */
  configured: boolean;
}

export interface ConversationSendRequest {
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
}

/** Host 接受用户消息后的排队结果；queued 表示尚未创建 Agent run。 */
export type ConversationSendResult =
  | {
      queueId: string;
      status: "started";
      position: 0;
      runId: string;
      snapshot: ConversationSnapshot;
    }
  | { queueId: string; status: "queued"; position: number };

export interface ConversationRunResult {
  runId: string;
  snapshot: ConversationSnapshot;
}

export type ConversationSendResponse = ConversationSendResult | ConversationRunResult;

export interface ConversationQueueCompletion {
  queueId: string;
  runId?: string;
  outcome: "completed" | "failed" | "aborted";
}

export interface ChatSendCommand {
  operation: "chat.send";
  conversationId: string;
  /** Bot to start with; absent means the conversation's active Bot or default entry. */
  botId?: string;
  request: ConversationSendRequest;
}

export interface TeamSendCommand {
  operation: "team.send";
  conversationId: string;
  teamId: string;
  request: ConversationSendRequest;
}

export interface AnswerRunCommand {
  operation: "answer.run";
  conversationId: string;
  request: ConversationSendRequest;
}

export type ConversationSendCommand = ChatSendCommand | TeamSendCommand | AnswerRunCommand;

/** New-conversation selection: one Bot or a predefined team. */
export type ConversationSelection =
  | { kind: "bot"; botId: string }
  | { kind: "team"; teamId: string };

export interface ConversationChannelMap {
  [ConversationChannels.Send]: {
    request: ConversationSendCommand;
    response: ConversationSendResponse;
  };
  [ConversationChannels.WaitQueue]: {
    request: { conversationId: string; queueId: string };
    response: { queueId: string; runId?: string; outcome: "completed" | "failed" | "aborted" };
  };
  [ConversationChannels.QueuePosition]: {
    request: { conversationId: string; queueId: string };
    response: number | undefined;
  };
  [ConversationChannels.AppendUserMessage]: {
    request: { conversationId: string; text: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.Cancel]: { request: { runId: string }; response: undefined };
  [ConversationChannels.GetSnapshot]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.Create]: {
    request: { conversationId: string; selection?: ConversationSelection };
    response: ConversationSnapshot;
  };
  [ConversationChannels.ReadEvents]: {
    request: { conversationId: string; afterRevision: number };
    response: AgentEventEnvelope[];
  };
  [ConversationChannels.GetConfig]: {
    request: undefined;
    response: ConversationModelSettingsView;
  };
  [ConversationChannels.Configure]: {
    request: ConversationModelSettings;
    response: ConversationModelSettingsView;
  };
  [ConversationChannels.GetApiKey]: { request: undefined; response: { apiKey: string | null } };
  [ConversationChannels.ClearConfig]: {
    request: undefined;
    response: ConversationModelSettingsView;
  };
  [ConversationChannels.ClearMessages]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.Compact]: {
    request: { conversationId: string; instructions?: string };
    response: { result: ManualCompactionResult; snapshot: ConversationSnapshot };
  };
  [ConversationChannels.ListBots]: {
    request: undefined;
    response: BotSummary[];
  };
  [ConversationChannels.ListSessions]: {
    request:
      | {
          scope?: ConversationSessionScope;
          cursor?: string;
          limit?: number;
        }
      | undefined;
    response: ConversationSessionPage;
  };
  [ConversationChannels.DeleteSession]: {
    request: { conversationId: string };
    response: undefined;
  };
  [ConversationChannels.Event]: { request: undefined; response: undefined };
  [ConversationChannels.SnapshotChanged]: { request: undefined; response: ConversationSnapshot };
}
