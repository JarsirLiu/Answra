/**
 * 跨进程频道契约的稳定聚合入口。
 *
 * 具体频道按领域维护在 `channels/` 下；本文件只负责保持既有导入路径，
 * 不承载领域定义。新增频道应进入对应领域文件，再从这里导出。
 */
export * from "./channels/ambient";
export * from "./channels/auth";
export * from "./channels/capture";
export * from "./channels/conversation";
export * from "./channels/interview";
export * from "./channels/window";
export * from "./channels/workspace";
