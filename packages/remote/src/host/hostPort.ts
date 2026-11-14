import type { ConversationQueueCompletion, ConversationSendResult } from "@answra/shared";
import type {
  AgentEventEnvelope,
  BotSummary,
  ConversationSnapshot,
  RemoteCapability,
  RemoteConversationSelection,
  RemoteLocalModelInput,
  RemoteModelConfig,
  RemoteModelSettingsView,
  RemoteSendCommand,
} from "@answra/shared/schema";
import type { Unsubscribe } from "../ports/subscription";

/** Host 本地模型设置端口；只处理非 secret 字段，API key 由 host 自己保留。 */
export interface HostModelSettingsPort {
  snapshot(): Promise<RemoteModelSettingsView>;
  addLocal(input: RemoteLocalModelInput): Promise<RemoteModelSettingsView>;
  switchChatModel(chatModel: string): Promise<RemoteModelSettingsView>;
  clearLocal(): Promise<RemoteModelSettingsView>;
}

/**
 * 远程 host 的命令门面：CLI 用 CodingApplication 适配，桌面用 AgentService 适配。
 * 端口不持有传输、不接收 accessToken，也不复制 Agent 领域逻辑。
 */
export interface HostCommandPort {
  capabilities(): readonly RemoteCapability[];
  createConversation(
    conversationId: string,
    selection?: RemoteConversationSelection,
  ): Promise<ConversationSnapshot>;
  clearConversation(conversationId: string): Promise<ConversationSnapshot>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  send(command: RemoteSendCommand): Promise<ConversationSendResult>;
  waitQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; runId: string; snapshot: ConversationSnapshot }>;
  waitQueue(conversationId: string, queueId: string): Promise<ConversationQueueCompletion>;
  cancel(runId: string): void;
  listBots?(): Promise<BotSummary[]>;
  selectBot?(conversationId: string, botId: string): Promise<void>;
  /** 把已选模型应用到 host 运行时；模型设置本身走 settings()。 */
  applyModel(config: RemoteModelConfig): void;
  settings(): HostModelSettingsPort;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe;
  onEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe;
}
