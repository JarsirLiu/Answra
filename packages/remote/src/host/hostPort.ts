import type { ConversationQueueCompletion, ConversationSendResult } from "@answra/shared";
import type {
  BotSummary,
  ConversationSessionPage,
  ConversationSnapshot,
  LiveFrame,
  RemoteCapability,
  RemoteConversationSelection,
  RemoteLocalModelInput,
  RemoteModelConfig,
  RemoteModelSettingsView,
  RemoteSendCommand,
  RemoteSessionListQuery,
  SessionFrame,
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
 * 远程 host 的命令门面：各宿主用本地 Agent 应用适配（CLI CodingApplication、桌面 AgentService）。
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
  readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]>;
  listSessions?(query?: RemoteSessionListQuery): Promise<ConversationSessionPage>;
  send(command: RemoteSendCommand): Promise<ConversationSendResult>;
  waitQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId: string; snapshot: ConversationSnapshot }>;
  waitQueue(conversationId: string, queueId: string): Promise<ConversationQueueCompletion>;
  cancel(conversationId: string, turnId: string): void;
  listBots?(): Promise<BotSummary[]>;
  selectBot?(conversationId: string, botId: string): Promise<void>;
  /** 把已选模型应用到 host 运行时；模型设置本身走 settings()。 */
  applyModel(config: RemoteModelConfig): void;
  settings(): HostModelSettingsPort;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe;
  /** 可重放的 durable 事实帧；controller 按 `seq` 折叠。 */
  onFrame(listener: (frame: SessionFrame) => void): Unsubscribe;
  /** 瞬时增量帧；允许丢失，不参与重放。 */
  onLiveFrame(listener: (frame: LiveFrame) => void): Unsubscribe;
}
