import type {
  RemoteControllerAttempt,
  RemoteControllerConnection,
  RemoteCredentialRecord,
  RemoteSignalingTimers,
} from "@answra/remote";
import type { AuthPort } from "../ports/authPort";
import type { HostCredentialStore } from "../ports/credentialPort";
import type { LifecyclePort } from "../ports/lifecyclePort";
import type { NetworkPort } from "../ports/networkPort";

/** 每次连接尝试的工厂；真实实现由 transport 组合 WebSocket、WebRTC 与 controller session。 */
export interface ControllerAttemptFactory {
  create(credential: RemoteCredentialRecord): Promise<RemoteControllerAttempt>;
}

export interface ControllerRuntimeDependencies {
  readonly auth: AuthPort;
  readonly credentials: HostCredentialStore;
  readonly network: NetworkPort;
  readonly lifecycle: LifecyclePort;
  readonly timers: RemoteSignalingTimers;
  readonly createAttempt: ControllerAttemptFactory;
}

/** 移动端连接用例；实现只组合 @answra/remote，不复制重连或命令语义。 */
export interface ControllerRuntime {
  connect(credential: RemoteCredentialRecord): Promise<void>;
  disconnect(): void;
  reconnectNow(): void;
  suspend(): void;
  resume(): void;
  connection(): RemoteControllerConnection | undefined;
}
