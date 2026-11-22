import type { ConversationQueueCompletion, ConversationSendResult } from "@answra/shared";
import {
  type AgentEventEnvelope,
  type BotSummary,
  type ConversationSessionPage,
  type ConversationSnapshot,
  conversationSessionPageSchema,
  conversationSnapshotSchema,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCapability,
  type RemoteCommand,
  type RemoteConversationSelection,
  type RemoteError,
  type RemoteFrame,
  type RemoteLocalModelInput,
  type RemoteModelConfig,
  type RemoteModelSettingsView,
  type RemoteSendCommand,
  type RemoteSessionListQuery,
  type RemoteWelcome,
  remoteBotListSchema,
  remoteEventListSchema,
  remoteModelSettingsViewSchema,
  remoteQueueCompletionSchema,
  remoteQueueStartSchema,
  remoteSendResultSchema,
} from "@answra/shared/schema";
import { parseRemoteAccessKey, type RemoteCredentialRecord } from "../access/accessKey";
import type { HostModelSettingsPort } from "../host/hostPort";
import type { RemoteLink } from "../ports/remoteLink";
import type { Unsubscribe } from "../ports/subscription";
import { RemoteOperationError, remoteError } from "../protocol/errors";

export type RemoteControllerState = "idle" | "connecting" | "ready" | "closed";

export interface RemoteControllerSessionOptions {
  link: RemoteLink;
  sessionId: string;
  peerId: string;
  credential: RemoteCredentialRecord;
  capabilities?: readonly RemoteCapability[];
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: RemoteOperationError) => void;
  parse: (value: unknown) => unknown;
}

/** controller 侧远程会话：握手、命令请求关联与 host 事实订阅。 */
export class RemoteControllerSession {
  private readonly link: RemoteLink;
  private readonly sessionId: string;
  private readonly peerId: string;
  private readonly credential: RemoteCredentialRecord;
  private readonly credentialSecret: string;
  private readonly controllerCapabilities: readonly RemoteCapability[];
  private readonly pending = new Map<string, PendingCommand>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  private readonly eventListeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly stateListeners = new Set<(state: RemoteControllerState) => void>();
  private readonly settingsPort: HostModelSettingsPort;
  private currentState: RemoteControllerState = "idle";
  private currentWelcome?: RemoteWelcome;
  private connectPromise?: Promise<RemoteWelcome>;
  private connectResolve?: (welcome: RemoteWelcome) => void;
  private connectReject?: (error: RemoteOperationError) => void;
  private requestSequence = 0;
  private helloed = false;
  private closed = false;

  constructor({
    link,
    sessionId,
    peerId,
    credential,
    capabilities = [],
  }: RemoteControllerSessionOptions) {
    this.link = link;
    this.sessionId = sessionId;
    this.peerId = peerId;
    this.credential = credential;
    this.credentialSecret = parseRemoteAccessKey(credential.key).secret;
    this.controllerCapabilities = capabilities;
    this.settingsPort = {
      snapshot: () => this.settingsSnapshot(),
      addLocal: (input) => this.settingsAddLocal(input),
      switchChatModel: (chatModel) => this.settingsSwitchChatModel(chatModel),
      clearLocal: () => this.settingsClearLocal(),
    };

    this.unsubscribers.push(
      this.link.onFrame((frame) => {
        this.handleFrame(frame);
      }),
    );
    this.unsubscribers.push(
      this.link.onState((state) => {
        if (state === "open") this.sendHello();
        else if (state === "closed") {
          this.finishClose(remoteError("remote-disconnected", "remote link closed"));
        }
      }),
    );
  }

  state(): RemoteControllerState {
    return this.currentState;
  }

  welcome(): RemoteWelcome | undefined {
    return this.currentWelcome;
  }

  capabilities(): readonly RemoteCapability[] {
    return this.currentWelcome?.capabilities ?? this.controllerCapabilities;
  }

  connect(): Promise<RemoteWelcome> {
    if (this.closed) {
      return Promise.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "remote session is closed")),
      );
    }
    if (this.connectPromise !== undefined) return this.connectPromise;

    this.setState("connecting");
    this.connectPromise = new Promise<RemoteWelcome>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.sendHello();
    });
    return this.connectPromise;
  }

  close(): void {
    if (this.closed) return;
    this.finishClose(remoteError("remote-disconnected", "remote session closed"));
    this.link.close();
  }

  async createConversation(
    conversationId: string,
    selection?: RemoteConversationSelection,
  ): Promise<ConversationSnapshot> {
    return this.sendCommand(
      {
        type: "create-conversation",
        conversationId,
        ...(selection === undefined ? {} : { selection }),
      },
      (value) => conversationSnapshotSchema.parse(value),
    );
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    return this.sendCommand({ type: "clear-conversation", conversationId }, (value) =>
      conversationSnapshotSchema.parse(value),
    );
  }

  async snapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.sendCommand({ type: "snapshot", conversationId }, (value) =>
      conversationSnapshotSchema.parse(value),
    );
  }

  async readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return this.sendCommand({ type: "read-events", conversationId, afterRevision }, (value) =>
      remoteEventListSchema.parse(value),
    );
  }

  async listSessions(query?: RemoteSessionListQuery): Promise<ConversationSessionPage> {
    return this.sendCommand(
      {
        type: "list-sessions",
        ...(query === undefined ? {} : { query }),
      },
      (value) => conversationSessionPageSchema.parse(value),
    );
  }

  async send(command: RemoteSendCommand): Promise<ConversationSendResult> {
    return this.sendCommand({ type: "send", command }, (value) =>
      remoteSendResultSchema.parse(value),
    );
  }

  async waitQueue(conversationId: string, queueId: string): Promise<ConversationQueueCompletion> {
    return this.sendCommand({ type: "wait-queue", conversationId, queueId }, (value) =>
      remoteQueueCompletionSchema.parse(value),
    );
  }

  async waitQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId: string; snapshot: ConversationSnapshot }> {
    return this.sendCommand({ type: "wait-queue-start", conversationId, queueId }, (value) =>
      remoteQueueStartSchema.parse(value),
    );
  }

  async cancel(conversationId: string, turnId: string): Promise<void> {
    await this.sendCommand({ type: "cancel", conversationId, turnId }, () => undefined);
  }

  async listBots(): Promise<BotSummary[]> {
    return this.sendCommand({ type: "list-bots" }, (value) => remoteBotListSchema.parse(value));
  }

  async selectBot(conversationId: string, botId: string): Promise<void> {
    await this.sendCommand({ type: "select-bot", conversationId, botId }, () => undefined);
  }

  applyModel(config: RemoteModelConfig): Promise<void> {
    return this.sendCommand({ type: "apply-model", config }, () => undefined);
  }

  settings(): HostModelSettingsPort {
    return this.settingsPort;
  }

  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: (state: RemoteControllerState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private settingsSnapshot(): Promise<RemoteModelSettingsView> {
    return this.sendCommand({ type: "settings-snapshot" }, (value) =>
      remoteModelSettingsViewSchema.parse(value),
    );
  }

  private settingsAddLocal(input: RemoteLocalModelInput): Promise<RemoteModelSettingsView> {
    return this.sendCommand({ type: "settings-add-local", input }, (value) =>
      remoteModelSettingsViewSchema.parse(value),
    );
  }

  private settingsSwitchChatModel(chatModel: string): Promise<RemoteModelSettingsView> {
    return this.sendCommand({ type: "settings-switch-chat-model", chatModel }, (value) =>
      remoteModelSettingsViewSchema.parse(value),
    );
  }

  private settingsClearLocal(): Promise<RemoteModelSettingsView> {
    return this.sendCommand({ type: "settings-clear-local" }, (value) =>
      remoteModelSettingsViewSchema.parse(value),
    );
  }

  private sendCommand<T>(command: RemoteCommand, parse: (value: unknown) => T): Promise<T> {
    if (this.closed || this.currentState !== "ready") {
      return Promise.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "remote session is not ready")),
      );
    }

    this.requestSequence += 1;
    const requestId = `request-${this.sessionId}-${this.requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        parse,
      });
      try {
        this.link.send({ type: "command", requestId, command });
      } catch {
        this.pending.delete(requestId);
        reject(
          new RemoteOperationError(remoteError("transport-closed", "remote link is not open")),
        );
      }
    });
  }

  private sendHello(): void {
    if (this.helloed || this.closed || this.link.state() !== "open") return;
    this.helloed = true;
    try {
      this.link.send({
        type: "hello",
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        role: "controller",
        sessionId: this.sessionId,
        peerId: this.peerId,
        capabilities: [...this.controllerCapabilities],
      });
      this.link.send({
        type: "auth",
        sessionId: this.sessionId,
        roomId: this.credential.roomId,
        keyId: this.credential.keyId,
        secret: this.credentialSecret,
      });
    } catch {
      this.finishClose(remoteError("transport-closed", "failed to send remote hello"));
      this.link.close();
    }
  }

  private handleFrame(frame: RemoteFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case "auth-error":
        this.finishClose(remoteError(frame.error.code, frame.error.message, frame.error.retryable));
        this.link.close();
        return;
      case "welcome":
        this.acceptWelcome(frame);
        return;
      case "command-ok":
        this.resolveCommand(frame.requestId, frame.value);
        return;
      case "command-error":
        this.rejectCommand(frame.requestId, frame.error);
        return;
      case "snapshot":
        for (const listener of this.snapshotListeners) listener(frame.snapshot);
        return;
      case "event":
        for (const listener of this.eventListeners) listener(frame.event);
        return;
      case "close":
        this.close();
        return;
      default:
        return;
    }
  }

  private acceptWelcome(welcome: RemoteWelcome): void {
    if (welcome.sessionId !== this.sessionId) {
      this.finishClose(remoteError("session-mismatch", "remote session does not match"));
      this.link.close();
      return;
    }

    this.currentWelcome = welcome;
    this.setState("ready");
    this.connectResolve?.(welcome);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private resolveCommand(requestId: string, value: unknown): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    try {
      pending.resolve(pending.parse(value));
    } catch {
      pending.reject(
        new RemoteOperationError(remoteError("invalid-frame", "remote command result is invalid")),
      );
    }
  }

  private rejectCommand(requestId: string, error: RemoteError): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.reject(
      new RemoteOperationError(remoteError(error.code, error.message, error.retryable)),
    );
  }

  private setState(state: RemoteControllerState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private finishClose(error: ReturnType<typeof remoteError>): void {
    if (this.closed) return;
    this.closed = true;
    this.setState("closed");
    this.rejectAll(new RemoteOperationError(error));
    this.connectReject?.(new RemoteOperationError(error));
    this.connectReject = undefined;
    this.connectResolve = undefined;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private rejectAll(error: RemoteOperationError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
