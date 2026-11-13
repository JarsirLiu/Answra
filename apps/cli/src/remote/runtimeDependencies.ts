/** 远程 host/controller 运行时依赖：服务准入、计时器、链路工厂与 ID 生成。 */
import type { RemoteSignalingTimers } from "@answra/remote";
import type { RemoteSignalingService } from "./signaling/remoteSignalingService";
import type { RemoteLinkFactory } from "./transport/remoteLinkFactory";

export interface RemoteRuntimeDependencies {
  signaling: RemoteSignalingService;
  timers: RemoteSignalingTimers;
  createLink: RemoteLinkFactory;
  createId(): string;
}
