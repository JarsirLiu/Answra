import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteAuth,
  type RemoteCommand,
  type RemoteErrorCode,
  type RemoteFrame,
  type RemoteHello,
  type RemoteModelSettingsView,
} from "@answra/shared/schema";
import {
  hashRemoteAccessKeySecret,
  isRemoteHostAccessKeyActive,
  type RemoteHostAccessKeyRecord,
} from "../access/accessKey";
import type { RemoteHostKeyStore } from "../ports/hostKeyStore";
import type { RemoteLink } from "../ports/remoteLink";
import type { Unsubscribe } from "../ports/subscription";
import { RemoteOperationError, remoteError, toRemoteError } from "../protocol/errors";
import type { HostCommandPort } from "./hostPort";

export interface RemoteHostSessionOptions {
  host: HostCommandPort;
  link: RemoteLink;
  hostKeys: RemoteHostKeyStore;
  hostId: string;
  workspaceRoot: string;
  leaseId?: string;
  now?: () => Date;
}

let leaseSequence = 0;

/** host 侧远程会话：校验握手、路由命令并把 host 事实流推给 controller。 */
export class RemoteHostSession {
  private readonly host: HostCommandPort;
  private readonly link: RemoteLink;
  private readonly hostKeys: RemoteHostKeyStore;
  private readonly hostId: string;
  private readonly workspaceRoot: string;
  private readonly leaseId: string;
  private readonly now: () => Date;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly closedListeners = new Set<() => void>();
  private activeSessionId?: string;
  private pendingSessionId?: string;
  private authAttempted = false;
  private welcomed = false;
  private closed = false;

  constructor({
    host,
    link,
    hostKeys,
    hostId,
    workspaceRoot,
    leaseId,
    now = () => new Date(),
  }: RemoteHostSessionOptions) {
    this.host = host;
    this.link = link;
    this.hostKeys = hostKeys;
    this.hostId = hostId;
    this.workspaceRoot = workspaceRoot;
    this.now = now;
    leaseSequence += 1;
    this.leaseId = leaseId ?? `lease-${leaseSequence}`;

    this.unsubscribers.push(
      this.link.onFrame((frame) => {
        this.handleFrame(frame);
      }),
    );
    this.unsubscribers.push(
      this.link.onState((state) => {
        if (state === "closed") this.cleanup();
      }),
    );
    this.unsubscribers.push(
      this.host.onSnapshot((snapshot) => {
        if (this.welcomed) this.send({ type: "snapshot", snapshot });
      }),
    );
    this.unsubscribers.push(
      this.host.onEvent((event) => {
        if (this.welcomed) this.send({ type: "event", event });
      }),
    );
  }

  onClosed(listener: () => void): Unsubscribe {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    this.link.close();
  }

  private handleFrame(frame: RemoteFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case "hello":
        this.acceptHello(frame);
        return;
      case "auth":
        void this.acceptAuth(frame);
        return;
      case "command":
        void this.handleCommand(frame.requestId, frame.command);
        return;
      case "close":
        this.close();
        return;
      default:
        return;
    }
  }

  private acceptHello(hello: RemoteHello): void {
    if (hello.role !== "controller") {
      this.link.close("invalid-handshake");
      return;
    }
    if (this.activeSessionId !== undefined) {
      if (this.activeSessionId !== hello.sessionId) {
        this.send({ type: "close", reason: "controller-busy" });
      }
      return;
    }

    this.pendingSessionId = hello.sessionId;
    this.authAttempted = false;
  }

  private async acceptAuth(auth: RemoteAuth): Promise<void> {
    if (this.pendingSessionId === undefined || this.authAttempted) {
      this.sendAuthError("unauthorized", "remote authentication is not available");
      return;
    }
    this.authAttempted = true;

    if (auth.sessionId !== this.pendingSessionId) {
      this.sendAuthError("session-mismatch", "remote session does not match");
      return;
    }

    let record: RemoteHostAccessKeyRecord | null;
    let secretHash: string;
    try {
      record = await this.hostKeys.getByKeyId(auth.keyId);
      secretHash = record === null ? "" : await hashRemoteAccessKeySecret(auth.secret);
    } catch {
      if (!this.closed) this.sendAuthError("internal", "failed to verify remote access key");
      return;
    }
    if (this.closed) return;

    if (record === null || record.roomId !== auth.roomId || record.secretHash !== secretHash) {
      this.sendAuthError("unauthorized", "remote access key is not valid");
      return;
    }
    if (record.revokedAt !== undefined) {
      this.sendAuthError("key-revoked", "remote access key was revoked");
      return;
    }
    if (!isRemoteHostAccessKeyActive(record, this.now())) {
      this.sendAuthError("key-expired", "remote access key expired");
      return;
    }

    this.activeSessionId = auth.sessionId;
    this.pendingSessionId = undefined;
    const modelSettings = await this.readModelSettings();
    if (this.closed) return;

    this.welcomed = true;
    this.send({
      type: "welcome",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: auth.sessionId,
      hostId: this.hostId,
      leaseId: this.leaseId,
      capabilities: [...this.host.capabilities()],
      workspaceRoot: this.workspaceRoot,
      ...(modelSettings === undefined ? {} : { modelSettings }),
    });
  }

  private sendAuthError(code: RemoteErrorCode, message: string): void {
    if (this.closed) return;
    this.pendingSessionId = undefined;
    this.send({ type: "auth-error", error: remoteError(code, message) });
  }

  private async handleCommand(requestId: string, command: RemoteCommand): Promise<void> {
    if (!this.welcomed) {
      this.send({
        type: "command-error",
        requestId,
        error: remoteError("session-mismatch", "remote session is not ready"),
      });
      return;
    }

    try {
      const value = await this.execute(command);
      if (this.closed) return;
      this.send(
        value === undefined
          ? { type: "command-ok", requestId }
          : { type: "command-ok", requestId, value },
      );
    } catch (error) {
      if (this.closed) return;
      this.send({ type: "command-error", requestId, error: toRemoteError(error) });
    }
  }

  private async execute(command: RemoteCommand): Promise<unknown> {
    switch (command.type) {
      case "create-conversation":
        return this.host.createConversation(command.conversationId, command.selection);
      case "clear-conversation":
        return this.host.clearConversation(command.conversationId);
      case "send":
        return this.host.send(command.command);
      case "wait-queue":
        return this.host.waitQueue(command.conversationId, command.queueId);
      case "wait-queue-start":
        return this.host.waitQueueStart(command.conversationId, command.queueId);
      case "cancel":
        this.host.cancel(command.conversationId, command.runId);
        return undefined;
      case "snapshot":
        return this.host.snapshot(command.conversationId);
      case "read-events":
        return this.host.readEvents(command.conversationId, command.afterRevision);
      case "list-sessions":
        return this.requireListSessions()(command.query);
      case "list-bots":
        return this.requireListBots()();
      case "select-bot":
        return this.requireSelectBot()(command.conversationId, command.botId);
      case "apply-model":
        this.host.applyModel(command.config);
        return undefined;
      case "settings-snapshot":
        return this.host.settings().snapshot();
      case "settings-add-local":
        return this.host.settings().addLocal(command.input);
      case "settings-switch-chat-model":
        return this.host.settings().switchChatModel(command.chatModel);
      case "settings-clear-local":
        return this.host.settings().clearLocal();
    }
  }

  private requireListSessions(): NonNullable<HostCommandPort["listSessions"]> {
    if (this.host.listSessions === undefined) {
      throw new RemoteOperationError(
        remoteError("invalid-command", "list-sessions is unsupported"),
      );
    }
    return this.host.listSessions.bind(this.host);
  }

  private requireListBots(): NonNullable<HostCommandPort["listBots"]> {
    if (this.host.listBots === undefined) {
      throw new RemoteOperationError(remoteError("invalid-command", "list-bots is unsupported"));
    }
    return this.host.listBots.bind(this.host);
  }

  private requireSelectBot(): NonNullable<HostCommandPort["selectBot"]> {
    if (this.host.selectBot === undefined) {
      throw new RemoteOperationError(remoteError("invalid-command", "select-bot is unsupported"));
    }
    return this.host.selectBot.bind(this.host);
  }

  private async readModelSettings(): Promise<RemoteModelSettingsView | undefined> {
    try {
      return await this.host.settings().snapshot();
    } catch {
      return undefined;
    }
  }

  private send(frame: RemoteFrame): void {
    if (this.closed) return;
    try {
      this.link.send(frame);
    } catch {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.welcomed = false;
    this.activeSessionId = undefined;
    this.pendingSessionId = undefined;
    this.authAttempted = false;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    if (!wasClosed) {
      for (const listener of this.closedListeners) listener();
      this.closedListeners.clear();
    }
  }
}
