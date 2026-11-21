import type { Unsubscribe } from "@answra/remote";

export type NetworkStatus = "online" | "offline" | "unknown";

/** 网络状态端口；只通知可达性变化，不承载连接状态机。 */
export interface NetworkPort {
  status(): NetworkStatus;
  onChange(listener: (status: NetworkStatus) => void): Unsubscribe;
}
