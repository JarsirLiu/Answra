import type { OverlayMode } from "./bridge";

/**
 * IPC 频道常量。
 *
 * 命名约定：`exam-assistant:<域>:<动作>`，与 ZCode 的
 * `<scope>:<kebab-domain>` 频道命名保持一致；所有跨进程通信
 * 必须在此登记，禁止在业务代码里手写字符串频道。
 */
export const WindowChannels = {
  /** 切换窗口模式（收起 / 打开内容面板），主进程据此调整窗口高度。 */
  SetMode: "exam-assistant:window:set-mode",
  /** 关闭应用窗口。 */
  Close: "exam-assistant:window:close",
} as const;

/**
 * 频道 → 请求/响应载荷 的类型映射。
 * preload 与 main 的 handler 均以此为准，实现三层类型安全。
 */
export interface WindowChannelMap {
  [WindowChannels.SetMode]: { request: OverlayMode; response: void };
  [WindowChannels.Close]: { request: void; response: void };
}

/** 按频道名取出请求/响应类型的工具类型。 */
export type ChannelRequest<C extends keyof WindowChannelMap> = WindowChannelMap[C]["request"];
export type ChannelResponse<C extends keyof WindowChannelMap> = WindowChannelMap[C]["response"];
