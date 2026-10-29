import type { UIMessageChunk } from "ai";

/** 对话运行、模型设置与会话快照的 IPC 频道和载荷契约。 */
export const ConversationChannels = {
  Send: "answra:conversation:send",
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
  Change: "answra:conversation:change",
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
 * 这是显式切换，不是优先级兜底：选哪一路就只用哪一路。本地来源仅在开发态可选，
 * 打包版固定云端，避免绕过订阅。
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
  /** 是否允许选择本地来源（仅开发态为 true）。 */
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

export interface ChatSendCommand {
  operation: "chat.send";
  conversationId: string;
  profileId: "general-chat";
  request: ConversationSendRequest;
}

export interface AnswerRunCommand {
  operation: "answer.run";
  conversationId: string;
  request: ConversationSendRequest;
}

export type ConversationSendCommand = ChatSendCommand | AnswerRunCommand;

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
  status: "complete" | "streaming" | "interrupted";
};

export type ConversationSnapshot = {
  conversationId: string;
  revision: number;
  messages: ConversationMessage[];
  activeRunId?: string;
};

export type ConversationEvent = {
  conversationId: string;
  runId: string;
  revision: number;
  chunk: UIMessageChunk;
};

export type ConversationChange =
  | { type: "snapshot"; snapshot: ConversationSnapshot }
  | {
      type: "messages-appended";
      conversationId: string;
      revision: number;
      messages: ConversationMessage[];
      activeRunId?: string;
    }
  | { type: "event"; event: ConversationEvent }
  | {
      type: "run-finished";
      conversationId: string;
      revision: number;
      runId: string;
      message: ConversationMessage;
    };

export interface ConversationChannelMap {
  [ConversationChannels.Send]: {
    request: ConversationSendCommand;
    response: { runId: string };
  };
  [ConversationChannels.AppendUserMessage]: {
    request: { conversationId: string; text: string };
    response: undefined;
  };
  [ConversationChannels.Cancel]: { request: { runId: string }; response: undefined };
  [ConversationChannels.GetSnapshot]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.Create]: {
    request: { conversationId: string };
    response: ConversationSnapshot;
  };
  [ConversationChannels.ReadEvents]: {
    request: { conversationId: string; afterRevision: number };
    response: ConversationChange[];
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
    response: undefined;
  };
  [ConversationChannels.Change]: { request: undefined; response: undefined };
}
