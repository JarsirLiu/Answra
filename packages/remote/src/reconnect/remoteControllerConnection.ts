import type { ConversationQueueCompletion, ConversationSendResult } from "@answra/shared";
import type {
  AgentEventEnvelope,
  BotSummary,
  ConversationSnapshot,
  RemoteCapability,
  RemoteModelConfig,
  RemoteSendCommand,
  RemoteWelcome,
} from "@answra/shared/schema";
import type { RemoteControllerSession } from "../controller/remoteControllerSession";
import type { HostModelSettingsPort } from "../host/hostPort";
import type { Unsubscribe } from "../ports/subscription";
import { RemoteOperationError, remoteError } from "../protocol/errors";
import type { RemoteSignalingTimers } from "../signaling/contracts";
import { isTerminalRemoteError, toRemoteUnreachable } from "./errors";
import { RemoteReconnectPolicy } from "./policy";

export type RemoteControllerConnectionState =
  | "idle"
  | "connecting"
  | "interrupted"
  | "reconnecting"
  | "ready"
  | "closed";

/** 一次 controller 尝试的资源；关闭时同时释放 session、link 和信令。 */
export interface RemoteControllerAttempt {
  readonly session: RemoteControllerSession;
  close(): void;
}

export interface RemoteControllerConnectionOptions {
  createAttempt(): Promise<RemoteControllerAttempt>;
  timers: RemoteSignalingTimers;
  policy?: RemoteReconnectPolicy;
  /** 新会话 ready 后追平 snapshot + events；失败按连接错误处理。 */
  resync?(session: RemoteControllerSession): Promise<void>;
}

/**
 * controller 连接协调器：唯一写连接状态、重试预算和 attempt generation。
 * 不创建 WebSocket/WebRTC，不持有 TUI/transcript；每次重连创建新的 session。
 */
export class RemoteControllerConnection {
  private readonly createAttempt: () => Promise<RemoteControllerAttempt>;
  private readonly timers: RemoteSignalingTimers;
  private readonly policy: RemoteReconnectPolicy;
  private readonly resync?: (session: RemoteControllerSession) => Promise<void>;
  private readonly stateListeners = new Set<(state: RemoteControllerConnectionState) => void>();
  private readonly sessionListeners = new Set<(session: RemoteControllerSession) => void>();
  private readonly snapshotListeners = new Set<(snapshot: ConversationSnapshot) => void>();
  private readonly eventListeners = new Set<(event: AgentEventEnvelope) => void>();
  private readonly errorListeners = new Set<(error: RemoteOperationError) => void>();
  private currentState: RemoteControllerConnectionState = "idle";
  private current?: RemoteControllerAttempt;
  private attemptUnsubscribers: Unsubscribe[] = [];
  private connectPromise?: Promise<RemoteWelcome>;
  private connectResolve?: (welcome: RemoteWelcome) => void;
  private connectReject?: (error: RemoteOperationError) => void;
  private cancelRetry?: () => void;
  private generation = 0;
  private hasConnected = false;
  private lastError?: unknown;
  private closed = false;

  constructor({
    createAttempt,
    timers,
    policy = new RemoteReconnectPolicy(),
    resync,
  }: RemoteControllerConnectionOptions) {
    this.createAttempt = createAttempt;
    this.timers = timers;
    this.policy = policy;
    this.resync = resync;
  }

  state(): RemoteControllerConnectionState {
    return this.currentState;
  }

  welcome(): RemoteWelcome | undefined {
    return this.current?.session.welcome();
  }

  capabilities(): readonly RemoteCapability[] {
    return this.current?.session.capabilities() ?? [];
  }

  session(): RemoteControllerSession | undefined {
    return this.current?.session;
  }

  connect(): Promise<RemoteWelcome> {
    if (this.closed) {
      return Promise.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "remote connection is closed")),
      );
    }
    if (this.connectPromise !== undefined) return this.connectPromise;
    if (this.currentState === "ready" && this.current !== undefined) {
      const welcome = this.current.session.welcome();
      if (welcome !== undefined) return Promise.resolve(welcome);
    }

    this.connectPromise = new Promise<RemoteWelcome>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.setState("connecting");
    void this.startAttempt();
    return this.connectPromise;
  }

  /** 网络切换或回前台：立即废弃当前 attempt 并继续退避重试。 */
  reconnectNow(): void {
    if (this.closed || this.currentState === "idle") return;
    this.cancelScheduledRetry();
    this.closeCurrentAttempt();
    this.generation += 1;
    this.policy.start();
    this.setState("interrupted");
    void this.startAttempt();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.cancelScheduledRetry();
    this.closeCurrentAttempt();
    this.setState("closed");
    this.rejectConnect(
      new RemoteOperationError(remoteError("remote-disconnected", "remote connection closed")),
    );
  }

  onState(listener: (state: RemoteControllerConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onSession(listener: (session: RemoteControllerSession) => void): Unsubscribe {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): Unsubscribe {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onError(listener: (error: RemoteOperationError) => void): Unsubscribe {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async createConversation(
    conversationId: string,
    selection?: Parameters<RemoteControllerSession["createConversation"]>[1],
  ): Promise<ConversationSnapshot> {
    return this.requireSession().createConversation(conversationId, selection);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    return this.requireSession().clearConversation(conversationId);
  }

  async snapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.requireSession().snapshot(conversationId);
  }

  async readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return this.requireSession().readEvents(conversationId, afterRevision);
  }

  async send(command: RemoteSendCommand): Promise<ConversationSendResult> {
    return this.requireSession().send(command);
  }

  async waitQueue(conversationId: string, queueId: string): Promise<ConversationQueueCompletion> {
    return this.requireSession().waitQueue(conversationId, queueId);
  }

  async waitQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; runId: string; snapshot: ConversationSnapshot }> {
    return this.requireSession().waitQueueStart(conversationId, queueId);
  }

  async cancel(runId: string): Promise<void> {
    return this.requireSession().cancel(runId);
  }

  async listBots(): Promise<BotSummary[]> {
    return this.requireSession().listBots();
  }

  async selectBot(conversationId: string, botId: string): Promise<void> {
    return this.requireSession().selectBot(conversationId, botId);
  }

  async applyModel(config: RemoteModelConfig): Promise<void> {
    return this.requireSession().applyModel(config);
  }

  settings(): HostModelSettingsPort {
    return {
      snapshot: async () => this.requireSession().settings().snapshot(),
      addLocal: async (input) => this.requireSession().settings().addLocal(input),
      switchChatModel: async (chatModel) =>
        this.requireSession().settings().switchChatModel(chatModel),
      clearLocal: async () => this.requireSession().settings().clearLocal(),
    };
  }

  private async startAttempt(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.setState(this.hasConnected ? "reconnecting" : "connecting");
    let attempt: RemoteControllerAttempt;
    try {
      attempt = await this.createAttempt();
    } catch (error) {
      this.handleAttemptFailure(generation, error);
      return;
    }
    if (this.closed || generation !== this.generation) {
      attempt.close();
      return;
    }

    this.current = attempt;
    let welcome: RemoteWelcome;
    try {
      welcome = await attempt.session.connect();
    } catch (error) {
      this.handleAttemptFailure(generation, error);
      return;
    }
    if (this.closed || generation !== this.generation) {
      this.closeAttempt(attempt);
      return;
    }

    if (this.resync !== undefined) {
      try {
        await this.resync(attempt.session);
      } catch (error) {
        this.handleAttemptFailure(generation, error);
        return;
      }
    }
    if (this.closed || generation !== this.generation) {
      this.closeAttempt(attempt);
      return;
    }

    this.attachAttempt(attempt, generation);
    if (attempt.session.state() === "closed") {
      this.handleAttemptClosed(generation);
      return;
    }
    this.hasConnected = true;
    this.lastError = undefined;
    this.policy.reset();
    this.setState("ready");
    for (const listener of this.sessionListeners) listener(attempt.session);
    this.connectResolve?.(welcome);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private attachAttempt(attempt: RemoteControllerAttempt, generation: number): void {
    this.attemptUnsubscribers = [
      attempt.session.onSnapshot((snapshot) => {
        for (const listener of this.snapshotListeners) listener(snapshot);
      }),
      attempt.session.onEvent((event) => {
        for (const listener of this.eventListeners) listener(event);
      }),
      attempt.session.onState((state) => {
        if (state === "closed") this.handleAttemptClosed(generation);
      }),
    ];
  }

  private handleAttemptClosed(generation: number): void {
    if (this.closed || generation !== this.generation) return;
    this.closeCurrentAttempt();
    this.setState("interrupted");
    this.scheduleRetry();
  }

  private handleAttemptFailure(generation: number, error: unknown): void {
    if (this.closed || generation !== this.generation) return;
    this.lastError = error;
    this.closeCurrentAttempt();
    if (isTerminalRemoteError(error)) {
      this.fail(error);
      return;
    }
    this.setState("interrupted");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.cancelRetry !== undefined) return;
    this.policy.start();
    const decision = this.policy.next();
    if (decision.kind === "exhausted") {
      this.fail(toRemoteUnreachable(this.lastError));
      return;
    }
    this.setState("interrupted");
    this.cancelRetry = this.timers.after(decision.delayMs, () => {
      this.cancelRetry = undefined;
      if (this.closed) return;
      this.setState("reconnecting");
      void this.startAttempt();
    });
  }

  private cancelScheduledRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  private closeCurrentAttempt(): void {
    const attempt = this.current;
    this.current = undefined;
    for (const unsubscribe of this.attemptUnsubscribers.splice(0)) unsubscribe();
    attempt?.close();
  }

  private closeAttempt(attempt: RemoteControllerAttempt): void {
    if (this.current === attempt) {
      this.current = undefined;
      for (const unsubscribe of this.attemptUnsubscribers.splice(0)) unsubscribe();
    }
    attempt.close();
  }

  private requireSession(): RemoteControllerSession {
    const attempt = this.current;
    if (this.closed || this.currentState !== "ready" || attempt === undefined) {
      throw new RemoteOperationError(
        remoteError("remote-disconnected", "remote connection is not ready", true),
      );
    }
    return attempt.session;
  }

  private fail(error: unknown): void {
    const remoteOperationError =
      error instanceof RemoteOperationError ? error : toRemoteUnreachable(error);
    this.closed = true;
    this.generation += 1;
    this.cancelScheduledRetry();
    this.closeCurrentAttempt();
    this.setState("closed");
    this.rejectConnect(remoteOperationError);
    for (const listener of this.errorListeners) listener(remoteOperationError);
  }

  private rejectConnect(error: RemoteOperationError): void {
    this.connectReject?.(error);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private setState(state: RemoteControllerConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
