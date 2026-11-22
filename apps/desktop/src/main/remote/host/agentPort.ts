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
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";

export interface DesktopRemoteSessionQuery {
  scope?: ConversationSessionScope;
  cursor?: string;
  limit?: number;
}

export interface DesktopRemoteQueueStart {
  queueId: string;
  turnId: string;
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
  readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]>;
  send(command: ChatSendCommand | TeamSendCommand): Promise<ConversationSendResponse>;
  waitForConversationQueue(
    conversationId: string,
    queueId: string,
  ): Promise<ConversationQueueCompletion>;
  waitForConversationQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<DesktopRemoteQueueStart>;
  cancelTurn(conversationId: string, turnId: string): void;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void;
  onSessionFrame(listener: (frame: SessionFrame) => void): () => void;
  onLiveFrame(listener: (frame: LiveFrame) => void): () => void;
}
