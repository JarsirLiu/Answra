/** 桌面 AgentService 中远程 host 所需的最小能力；只做类型适配，不持有传输或平台状态。 */
import type {
  ChatSendCommand,
  ConversationQueueCompletion,
  ConversationSelection,
  ConversationSendResponse,
  ConversationSessionPage,
  ConversationSessionScope,
  ConversationSnapshot,
  TeamSendCommand,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";

export interface DesktopRemoteSessionQuery {
  scope?: ConversationSessionScope;
  cursor?: string;
  limit?: number;
}

export interface DesktopRemoteQueueStart {
  queueId: string;
  runId: string;
  snapshot: ConversationSnapshot;
}

export interface DesktopRemoteAgentPort {
  listConversationSessions(query?: DesktopRemoteSessionQuery): Promise<ConversationSessionPage>;
  createConversation(
    conversationId: string,
    selection?: ConversationSelection,
  ): Promise<ConversationSnapshot>;
  clearConversation(conversationId: string): Promise<ConversationSnapshot>;
  getSnapshot(conversationId: string): Promise<ConversationSnapshot>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  send(command: ChatSendCommand | TeamSendCommand): Promise<ConversationSendResponse>;
  waitForConversationQueue(
    conversationId: string,
    queueId: string,
  ): Promise<ConversationQueueCompletion>;
  waitForConversationQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<DesktopRemoteQueueStart>;
  cancel(runId: string): void;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void;
  onEvent(listener: (event: AgentEventEnvelope) => void): () => void;
}
