/** 桌面远程 host 生命周期：连接码、host 密钥存储、信令重连与 Agent 命令端口的唯一组合根。 */
import { randomUUID } from "node:crypto";
import {
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  isRemoteHostAccessKeyActive,
  type RemoteHostConnectionState,
  type RemoteHostKeyStore,
  RemoteOperationError,
  remoteError,
} from "@answra/remote";
import {
  createNodeSignalingTimers,
  createRemoteSignalingService,
  NodeWebRtcLink,
  type RemoteHostHandle,
  type RemoteRuntimeDependencies,
  startRemoteHost,
} from "@answra/remote-node";
import type {
  RemoteHostConnectResult,
  RemoteHostKeyCreation,
  RemoteHostState,
  RemoteHostStatus,
} from "@answra/shared";
import { createEncryptedRemoteHostKeyStore } from "../credentials/encryptedRemoteHostKeyStore";
import type { DesktopRemoteAgentPort } from "./agentPort";
import { createDesktopRemoteCommandPort } from "./commandPort";

export interface DesktopRemoteHostServiceDeps {
  configDir: string;
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  getWorkspaceRoot: () => string | null;
  agent: DesktopRemoteAgentPort;
  hostKeys?: RemoteHostKeyStore;
  startHost?: typeof startRemoteHost;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export class DesktopRemoteHostService {
  private readonly hostKeys: RemoteHostKeyStore;
  private readonly startHost: typeof startRemoteHost;
  private readonly deps: DesktopRemoteHostServiceDeps;
  private readonly listeners = new Set<(status: RemoteHostStatus) => void>();
  private handle?: RemoteHostHandle;
  private starting?: Promise<void>;
  private startGeneration = 0;
  private state: RemoteHostState = "stopped";
  private statusLine: string | null = null;
  private lastError: string | null = null;
  private statusSequence = 0;

  constructor(deps: DesktopRemoteHostServiceDeps) {
    this.deps = deps;
    this.hostKeys = deps.hostKeys ?? createEncryptedRemoteHostKeyStore(deps.configDir);
    this.startHost = deps.startHost ?? startRemoteHost;
  }

  onStatus(listener: (status: RemoteHostStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getStatus(): Promise<RemoteHostStatus> {
    return this.buildStatus();
  }

  async connect(): Promise<RemoteHostConnectResult> {
    const key = await this.createKey();
    try {
      return { key, status: await this.start() };
    } catch (error) {
      await this.stop();
      await this.revokeKey(key.keyId);
      throw error;
    }
  }

  async disconnect(): Promise<RemoteHostStatus> {
    await this.stop();
    await this.revokeActiveKeys();
    this.lastError = null;
    this.emitStatus();
    return this.buildStatus();
  }

  async createKey(): Promise<RemoteHostKeyCreation> {
    if (this.starting !== undefined) await this.starting.catch(() => undefined);
    await this.stop();
    await this.revokeActiveKeys();

    const generated = generateRemoteAccessKey({ now: this.now(), permanent: true });
    await this.hostKeys.save(
      await createRemoteHostAccessKeyRecord(generated, { label: "desktop" }),
    );
    this.lastError = null;
    this.emitStatus();

    return {
      key: generated.key,
      keyId: generated.keyId,
      ...(generated.expiresAt === undefined ? {} : { expiresAt: generated.expiresAt }),
    };
  }

  async start(): Promise<RemoteHostStatus> {
    if (this.starting !== undefined) {
      await this.starting;
      return this.buildStatus();
    }
    if (this.handle !== undefined) return this.buildStatus();

    const record = await this.selectActiveKey();
    if (record === null) {
      throw new RemoteOperationError(remoteError("invalid-command", "请先生成远程连接码。"));
    }
    await this.deps.getAccessToken();
    const generation = ++this.startGeneration;
    this.lastError = null;
    this.statusLine = null;
    this.state = "starting";
    this.emitStatus();

    const starting = this.startInternal(record.roomId, generation);
    this.starting = starting;
    try {
      await starting;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.state = "stopped";
      this.handle = undefined;
      this.emitStatus();
      throw error;
    } finally {
      this.starting = undefined;
    }
    return this.buildStatus();
  }

  async stop(): Promise<RemoteHostStatus> {
    this.startGeneration += 1;
    const handle = this.handle;
    this.handle = undefined;
    this.state = "stopped";
    this.statusLine = null;
    if (handle !== undefined) {
      await handle.stop().catch((error: unknown) => {
        this.deps.log?.("[remote-host] 停止失败", error);
      });
    }
    this.emitStatus();
    return this.buildStatus();
  }

  async onAuthStatus(signedIn: boolean): Promise<void> {
    if (signedIn) return;
    await this.stop();
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.stop();
  }

  private async startInternal(roomId: string, generation: number): Promise<void> {
    const runtime: RemoteRuntimeDependencies = {
      signaling: createRemoteSignalingService({
        baseUrl: this.deps.apiBaseUrl,
        getAccessToken: this.deps.getAccessToken,
      }),
      timers: createNodeSignalingTimers(),
      createLink: (options) => new NodeWebRtcLink(options),
      createId: randomUUID,
    };
    const handle = await this.startHost({
      runtime,
      hostKeys: this.hostKeys,
      host: createDesktopRemoteCommandPort(this.deps.agent),
      workspaceRoot: this.deps.getWorkspaceRoot() ?? "",
      roomId,
      onStatus: (line) => {
        if (this.startGeneration !== generation) return;
        this.statusLine = line;
        this.emitStatus();
      },
    });
    if (this.startGeneration !== generation) {
      await handle.stop().catch(() => undefined);
      return;
    }
    this.handle = handle;
    this.applyConnectionState(handle.state());
    handle.onState((state) => {
      if (this.handle === handle) this.applyConnectionState(state);
    });
    handle.onError((error) => {
      if (this.handle !== handle) return;
      this.lastError = error.message;
      this.emitStatus();
    });
    void handle.done.catch((error: unknown) => {
      if (this.handle !== handle) return;
      this.handle = undefined;
      this.state = "stopped";
      this.lastError = errorMessage(error);
      this.emitStatus();
    });
  }

  private applyConnectionState(state: RemoteHostConnectionState): void {
    if (state === "closed") {
      this.state = "stopped";
      if (this.handle?.state() === "closed") this.handle = undefined;
    } else {
      this.state = mapConnectionState(state);
    }
    this.emitStatus();
  }

  private async revokeActiveKeys(): Promise<void> {
    const now = this.now();
    for (const record of await this.hostKeys.list()) {
      if (isRemoteHostAccessKeyActive(record, now)) {
        await this.hostKeys.revoke(record.keyId, now.toISOString());
      }
    }
  }

  private async revokeKey(keyId: string): Promise<void> {
    await this.hostKeys.revoke(keyId, this.now().toISOString());
  }

  private async selectActiveKey() {
    const now = this.now();
    const records = await this.hostKeys.list();
    return (
      records
        .filter((record) => isRemoteHostAccessKeyActive(record, now))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
    );
  }

  private async buildStatus(): Promise<RemoteHostStatus> {
    const now = this.now();
    const active = (await this.hostKeys.list())
      .filter((record) => isRemoteHostAccessKeyActive(record, now))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return {
      running: this.state !== "stopped",
      state: this.state,
      key:
        active === undefined
          ? null
          : {
              keyId: active.keyId,
              ...(active.label === undefined ? {} : { label: active.label }),
              createdAt: active.createdAt,
              ...(active.expiresAt === undefined ? {} : { expiresAt: active.expiresAt }),
            },
      statusLine: this.statusLine,
      lastError: this.lastError,
    };
  }

  private emitStatus(): void {
    const sequence = ++this.statusSequence;
    void this.buildStatus().then(
      (status) => {
        if (sequence !== this.statusSequence) return;
        for (const listener of this.listeners) listener(status);
      },
      (error: unknown) => {
        if (sequence === this.statusSequence) {
          this.deps.log?.("[remote-host] 读取状态失败", error);
        }
      },
    );
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function mapConnectionState(state: RemoteHostConnectionState): RemoteHostState {
  switch (state) {
    case "idle":
    case "closed":
      return "stopped";
    case "starting":
      return "starting";
    case "waiting":
      return "waiting";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "reconnecting":
      return "reconnecting";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "远程连接失败";
}
