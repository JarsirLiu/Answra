/**
 * @answra/agent 公共入口：desktop 的 worker 只从这里导入。
 *
 * 目录分层（按领域切分，新增领域平行加目录，减少并行开发的改动冲突）：
 *   worker/protocol.ts      worker 线协议（与 desktop main 之间的唯一契约）
 *   conversation/runtime.ts 会话运行时：模型调用、运行生命周期、取消
 *   conversation/store.ts   会话存储端口与内存适配器
 *
 * 平台能力（读屏/音频/DOM 采集、键鼠注入、窗口与密钥）不在这里实现：
 * 运行时只持有端口，由 desktop 注入实现，因此本包不依赖 Electron 与 React。
 */

export { ConversationRuntime } from "./conversation/runtime";
export type { ConversationStore } from "./conversation/store";
export { MemoryConversationStore } from "./conversation/store";
export type { AgentCommand, AgentFrame } from "./worker/protocol";
