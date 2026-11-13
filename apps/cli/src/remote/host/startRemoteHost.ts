/** 远程 host 常驻运行时：join 房间、等 controller、按 peer 建立 WebRTC 与 RemoteHostSession。 */
import {
  type HostCommandPort,
  type RemoteHostKeyStore,
  RemoteHostSession,
  type RemoteLink,
  RemoteOperationError,
  remoteError,
  type Unsubscribe,
} from "@answra/remote";
import type { RemoteRuntimeDependencies } from "../runtimeDependencies";
import { connectRemoteSignaling } from "../signaling/connectRemoteSignaling";

export interface StartRemoteHostOptions {
  runtime: RemoteRuntimeDependencies;
  hostKeys: RemoteHostKeyStore;
  host: HostCommandPort;
  workspaceRoot: string;
  roomId: string;
  onStatus?: (line: string) => void;
}

export interface RemoteHostHandle {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

interface ActiveConnection {
  readonly link: RemoteLink;
  readonly session: RemoteHostSession;
  readonly unsubscribe: Unsubscribe;
}

/** 返回时已完成 signaling join；`done` 在 SIGINT 停止或信令失败时收口。 */
export async function startRemoteHost({
  runtime,
  hostKeys,
  host,
  workspaceRoot,
  roomId,
  onStatus,
}: StartRemoteHostOptions): Promise<RemoteHostHandle> {
  const hostId = runtime.createId();
  const signaling = await connectRemoteSignaling({
    service: runtime.signaling,
    timers: runtime.timers,
    role: "host",
    roomId,
    peerId: hostId,
  });

  let active: ActiveConnection | undefined;
  let stopping = false;
  let settled = false;
  let resolveDone: () => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const unsubscribers: Unsubscribe[] = [];

  const settle = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (error === undefined) resolveDone();
    else rejectDone(error);
  };

  const closeActive = (): void => {
    const current = active;
    if (current === undefined) return;
    active = undefined;
    current.unsubscribe();
    current.session.close();
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    closeActive();
    signaling.close();
    settle();
  };

  const fail = (error: RemoteOperationError): void => {
    if (stopping) return;
    stopping = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    closeActive();
    signaling.close();
    settle(error);
  };

  const handlePeer = (): void => {
    if (stopping || active !== undefined) return;
    const link = runtime.createLink({ role: "host", signaling });
    const remote = new RemoteHostSession({
      host,
      link,
      hostKeys,
      hostId,
      workspaceRoot,
    });
    const unsubscribe = link.onState((state) => {
      if (state !== "closed") return;
      unsubscribe();
      if (active?.session === remote) active = undefined;
      onStatus?.("controller 已断开，继续等待。");
    });
    active = { link, session: remote, unsubscribe };
    onStatus?.("controller 已连接。");
  };

  unsubscribers.push(
    signaling.onPeerJoined(() => handlePeer()),
    signaling.onPeerLeft(() => {
      if (active === undefined) return;
      closeActive();
      onStatus?.("controller 已断开，继续等待。");
    }),
    signaling.onError((error) => fail(error)),
    signaling.onState((state) => {
      if (state === "closed" && !stopping) {
        fail(
          new RemoteOperationError(
            remoteError("remote-disconnected", "remote signaling channel closed"),
          ),
        );
      }
    }),
  );

  const existingPeer = signaling.peer();
  if (existingPeer !== undefined) handlePeer();
  onStatus?.("已连接信令服务，等待 controller。");

  return { done, stop };
}
