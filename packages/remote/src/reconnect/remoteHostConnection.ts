import type { RemoteHostSession } from "../host/remoteHostSession";
import type { Unsubscribe } from "../ports/subscription";
import { RemoteOperationError } from "../protocol/errors";
import type { RemoteSignalingTimers } from "../signaling/contracts";
import type { RemoteSignalingSession } from "../signaling/remoteSignalingSession";
import { isTerminalRemoteError, toRemoteUnreachable } from "./errors";
import { RemoteReconnectPolicy } from "./policy";

export type RemoteHostConnectionState =
  | "idle"
  | "starting"
  | "waiting"
  | "ready"
  | "interrupted"
  | "reconnecting"
  | "closed";

export interface RemoteHostAttempt {
  readonly session: RemoteHostSession;
  close(): void;
}

export interface RemoteHostConnectionOptions {
  createSignaling(): Promise<RemoteSignalingSession>;
  createAttempt(signaling: RemoteSignalingSession): RemoteHostAttempt;
  timers: RemoteSignalingTimers;
  policy?: RemoteReconnectPolicy;
  onStatus?(line: string): void;
}

/**
 * host 连接协调器：唯一写信令重连、房间重入和 active controller。
 * 不创建 WebSocket/WebRTC，不持有 Agent run；host 命令端口在重连间保持不变。
 */
export class RemoteHostConnection {
  private readonly createSignaling: () => Promise<RemoteSignalingSession>;
  private readonly createAttempt: (signaling: RemoteSignalingSession) => RemoteHostAttempt;
  private readonly timers: RemoteSignalingTimers;
  private readonly policy: RemoteReconnectPolicy;
  private readonly onStatus?: (line: string) => void;
  private readonly stateListeners = new Set<(state: RemoteHostConnectionState) => void>();
  private readonly errorListeners = new Set<(error: RemoteOperationError) => void>();
  private readonly donePromise: Promise<void>;
  private resolveDone: () => void = () => undefined;
  private rejectDone: (error: unknown) => void = () => undefined;
  private currentState: RemoteHostConnectionState = "idle";
  private signaling?: RemoteSignalingSession;
  private signalingUnsubscribers: Unsubscribe[] = [];
  private active?: RemoteHostAttempt;
  private activeUnsubscribers: Unsubscribe[] = [];
  private cancelRetry?: () => void;
  private generation = 0;
  private stopping = false;
  private closed = false;
  private lastError?: unknown;

  constructor({
    createSignaling,
    createAttempt,
    timers,
    policy = new RemoteReconnectPolicy(),
    onStatus,
  }: RemoteHostConnectionOptions) {
    this.createSignaling = createSignaling;
    this.createAttempt = createAttempt;
    this.timers = timers;
    this.policy = policy;
    this.onStatus = onStatus;
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  get done(): Promise<void> {
    return this.donePromise;
  }

  state(): RemoteHostConnectionState {
    return this.currentState;
  }

  async start(): Promise<void> {
    if (this.closed || this.stopping || this.currentState !== "idle") return;
    this.setState("starting");
    await this.startSignaling(this.generation + 1, true);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.closed = true;
    this.generation += 1;
    this.cancelScheduledRetry();
    this.closeActive();
    this.closeSignaling();
    this.setState("closed");
    this.resolveDone();
  }

  onState(listener: (state: RemoteHostConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (error: RemoteOperationError) => void): Unsubscribe {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private async startSignaling(generation: number, initial: boolean): Promise<void> {
    if (this.closed || this.stopping || generation !== this.generation + 1) return;
    this.generation = generation;
    this.setState(initial ? "starting" : "reconnecting");
    let signaling: RemoteSignalingSession;
    try {
      signaling = await this.createSignaling();
    } catch (error) {
      if (generation !== this.generation || this.closed || this.stopping) return;
      this.lastError = error;
      if (initial) {
        this.fail(error);
        throw error;
      }
      this.scheduleRetry(error);
      return;
    }
    if (this.closed || this.stopping || generation !== this.generation) {
      signaling.close();
      return;
    }

    this.signaling = signaling;
    this.attachSignaling(signaling, generation);
    this.policy.reset();
    this.setState("waiting");
    this.onStatus?.("已连接信令服务，等待 controller。");
    if (signaling.peer() !== undefined) this.handlePeer(generation);
  }

  private attachSignaling(signaling: RemoteSignalingSession, generation: number): void {
    this.signalingUnsubscribers = [
      signaling.onPeerJoined(() => {
        if (generation === this.generation) this.handlePeer(generation);
      }),
      signaling.onPeerLeft(() => {
        if (generation === this.generation) this.handlePeerLeft();
      }),
      signaling.onError((error) => {
        if (generation !== this.generation) return;
        this.lastError = error;
        if (isTerminalRemoteError(error)) this.fail(error);
      }),
      signaling.onState((state) => {
        if (generation !== this.generation) return;
        if (state === "closed") this.handleSignalingClosed(generation);
      }),
    ];
  }

  private handlePeer(generation: number): void {
    if (this.closed || this.stopping || generation !== this.generation) return;
    if (this.active !== undefined) return;
    const signaling = this.signaling;
    if (signaling === undefined) return;
    try {
      const attempt = this.createAttempt(signaling);
      this.active = attempt;
      this.attachAttempt(attempt, generation);
      this.setState("ready");
      this.onStatus?.("controller 已连接。");
    } catch (error) {
      this.lastError = error;
      this.fail(error);
    }
  }

  private attachAttempt(attempt: RemoteHostAttempt, generation: number): void {
    for (const unsubscribe of this.activeUnsubscribers.splice(0)) unsubscribe();
    const unsubscribe = attempt.session.onClosed(() => {
      if (generation !== this.generation) return;
      if (this.active !== attempt) return;
      this.closeActive();
      this.setState("waiting");
      this.onStatus?.("controller 已断开，继续等待。");
    });
    this.activeUnsubscribers.push(unsubscribe);
  }

  private handlePeerLeft(): void {
    if (this.active === undefined) return;
    this.closeActive();
    this.setState("waiting");
    this.onStatus?.("controller 已断开，继续等待。");
  }

  private handleSignalingClosed(generation: number): void {
    if (generation !== this.generation || this.closed || this.stopping) return;
    this.closeActive();
    this.closeSignaling();
    this.setState("interrupted");
    this.scheduleRetry(this.lastError);
  }

  private scheduleRetry(error: unknown): void {
    if (this.closed || this.stopping || this.cancelRetry !== undefined) return;
    this.lastError = error;
    this.policy.start();
    const decision = this.policy.next();
    if (decision.kind === "exhausted") {
      this.fail(toRemoteUnreachable(error));
      return;
    }
    const generation = this.generation + 1;
    this.cancelRetry = this.timers.after(decision.delayMs, () => {
      this.cancelRetry = undefined;
      if (this.closed || this.stopping) return;
      void this.startSignaling(generation, false);
    });
  }

  private cancelScheduledRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  private closeActive(): void {
    const active = this.active;
    this.active = undefined;
    for (const unsubscribe of this.activeUnsubscribers.splice(0)) unsubscribe();
    active?.close();
  }

  private closeSignaling(): void {
    const signaling = this.signaling;
    this.signaling = undefined;
    for (const unsubscribe of this.signalingUnsubscribers.splice(0)) unsubscribe();
    signaling?.close();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const remoteOperationError =
      error instanceof RemoteOperationError ? error : toRemoteUnreachable(error);
    this.closed = true;
    this.generation += 1;
    this.cancelScheduledRetry();
    this.closeActive();
    this.closeSignaling();
    this.setState("closed");
    for (const listener of this.errorListeners) listener(remoteOperationError);
    this.rejectDone(remoteOperationError);
  }

  private setState(state: RemoteHostConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
