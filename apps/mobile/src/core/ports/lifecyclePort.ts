import type { Unsubscribe } from "@answra/remote";

export type LifecycleState = "active" | "background";

/** 前后台端口；只通知生命周期变化，不决定是否重连。 */
export interface LifecyclePort {
  state(): LifecycleState;
  onChange(listener: (state: LifecycleState) => void): Unsubscribe;
}
