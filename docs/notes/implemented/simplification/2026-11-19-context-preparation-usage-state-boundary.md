# Note：上下文准备与 usage 状态分责

状态：已实施

## 问题

`ContextPreparation` 同时编排最终模型请求、压缩与裁剪，又维护 usage 校准锚点和 provider usage 持久化。请求准备与响应后状态维护有不同触发时机，集中在一个类中会让上下文策略修改与 usage 生命周期修改争用同一文件。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/preparation.ts`：保留预算解析、清理/压缩/裁剪编排和准备状态保存。
  - `apps/agent/src/core/context/usageState.ts`：组合锚点跟踪器，负责准备状态写入、锚点登记、run 事件消费和 provider 输入 usage 持久化。
  - `apps/agent/src/core/context/usageAnchor.ts`：继续负责成功 run 的锚点提交与失败失效。
- 测试：`apps/agent/test/core/context/preparation.test.ts` 继续验证准备流程、usage 状态持久化和锚点生命周期。
- UI/协议/数据库：不改变事件契约、展示行为或持久化 schema。

## 决定

- 在同一 `core/context` 域内新增 `ContextStateCoordinator`，集中会话上下文状态读写与 usage 锚点生命周期；`ContextPreparation` 委托状态副作用。
- 保持 `ContextPreparation.recordRunEvent()` 作为现有应用层接入方法，避免改变 Conversation、Coding、Interview 的接线。
- 不把 usage 状态上提至 shared，也不改 Agent event：它只服务上下文预算校准和最近请求用量展示，仍属于 Agent 上下文域。

## 曾考虑的替代方案

- **把事件接收和持久化放进 `ContextUsageAnchorTracker`**：锚点提交与最近 provider usage 是两个不同状态事实；合并会让锚点模块继续承担 UI 状态持久化，职责更宽，因此舍弃。
- **改造 Conversation/Coding/Interview 三个应用的事件接线**：会扩大变更面并制造重复状态接收逻辑，现有单一编排类保留稳定入口更利于并行开发，因此舍弃。

## 后果与防回退

- usage 生命周期可独立修改和测试；请求准备文件不再直接实现响应后 usage 更新。
- store 端口仍由组合根通过 `ContextPreparationOptions` 注入，没有新增状态 writer 或持久化真相源。
- 若后续扩展账单或成本统计，不应塞入此类；需先明确其数据契约与生命周期，再决定归属。

## 移除内容

- 从 `ContextPreparation` 移除上下文状态写入、usage 锚点跟踪器的直接持有和 provider usage 持久化实现；对外 `recordRunEvent()` 接口保留并委托给 `ContextStateCoordinator`。

## 重新引入条件

- 不得把锚点生命周期或 provider usage 写回重新放进上下文请求编排类。若要调整职责，需有第二个真实消费者或明确的新状态契约，并同步更新该 Note 与相应测试。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/context/preparation.test.ts test/core/model/streamEvents.test.ts`：30 项通过。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm exec biome check apps/agent/src/core/context/preparation.ts apps/agent/src/core/context/usageState.ts`、`git diff --check`、`pnpm notes:check`：通过。
- `pnpm verify`：lint、各包 typecheck、数据库检查和 UI 测试通过；Agent 全量测试有 2 项现存 shell 子进程测试失败（累计输出截断断言、Windows 进程树超时），与本次 context 状态重构无关。
