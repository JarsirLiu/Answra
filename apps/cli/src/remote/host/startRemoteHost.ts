/** 远程 host 常驻运行时：信令重连、等待 controller、按 peer 建立 WebRTC 与 RemoteHostSession。 */
import {
  type HostCommandPort,
  RemoteHostConnection,
  type RemoteHostKeyStore,
  RemoteHostSession,
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

/** 返回时已完成首次 signaling join；`done` 在 SIGINT、终态失败或重连预算耗尽时收口。 */
export async function startRemoteHost({
  runtime,
  hostKeys,
  host,
  workspaceRoot,
  roomId,
  onStatus,
}: StartRemoteHostOptions): Promise<RemoteHostHandle> {
  const hostId = runtime.createId();
  const connection = new RemoteHostConnection({
    timers: runtime.timers,
    onStatus,
    createSignaling: () =>
      connectRemoteSignaling({
        service: runtime.signaling,
        timers: runtime.timers,
        role: "host",
        roomId,
        peerId: hostId,
      }),
    createAttempt(signaling) {
      const link = runtime.createLink({ role: "host", signaling });
      const session = new RemoteHostSession({
        host,
        link,
        hostKeys,
        hostId,
        workspaceRoot,
      });
      return {
        session,
        close: () => {
          session.close();
        },
      };
    },
  });

  try {
    await connection.start();
  } catch (error) {
    void connection.done.catch(() => undefined);
    await connection.stop();
    throw error;
  }

  return {
    done: connection.done,
    stop: () => connection.stop(),
  };
}
