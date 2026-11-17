# Note：CLI 多会话运行与切回

状态：已实施

当前阶段：CLI/TUI 在同一进程内为每个会话保留独立 queue、busy/cancel 与 `CodingSession`；运行中的会话可切走，切回时从 Agent host 读取最新快照后继续接收事件。持久化仍只保存 transcript checkpoint，不支持进程重启后恢复在途 run。

## 问题

CLI/TUI 之前只有一个全局 `queue`、`busy` 与当前 `CodingSession`，且 `/resume` 与面板恢复都是 idle-only。用户在有 run 运行时无法切到另一个会话；如果直接放开限制，后台会话的 snapshot/event 会污染前台视图，输入可能被错误的队列消费，Esc 也无法区分要取消哪个会话。

CLI 的会话存储、Agent 应用层和 SQLite 已能按 `conversationId` 保存并并行运行不同会话，缺的是 TUI 宿主的运行编排与事件路由。

## 涉及范围

- `apps/cli/src/tui/runController.ts`：新增每会话运行控制器。
- `apps/cli/src/tui/runTui.tsx`、`apps/cli/src/tui/panelHandlers.ts`、`apps/cli/src/cli/codeCommand.ts`：接线、面板动作与进程中断。
- `apps/cli/src/tui/app/viewStore.ts`：只接受活动会话的 snapshot/event，切换时重置 revision。
- `apps/cli/src/tui/commands/{access,catalog}.ts`、`handlers/session.ts`：命令可用性、切换/新建/删除端口。
- `apps/cli/src/session/codingSession.ts`：新增非 idle 的最新快照读取与模型配置只读入口。
- 不影响 desktop：renderer 的 `useConversationView` 已按活动 `conversationId` 过滤事件。
- 不新增 Agent 事件表、持久化 run 状态或第二套事件投影。

## 决定

1. `TuiRunController` 为每个 `conversationId` 维护 `SessionRuntime`：`CodingSession`、输入 queue、`busy`、`cancelRequested`。不同会话可同时运行；同一会话仍保持单活动 run。
2. 只有活动 runtime 能把 `queued`、`phase`、错误写到 `TuiViewStore`。后台完成或失败不改变前台 phase；后台失败改为通知，切回后以快照为准。
3. `TuiViewStore` 记录活动 `conversationId`：其他会话的 snapshot/event 直接丢弃；切换时先清空旧 view、revision 与 pending events，再应用目标快照。
4. `/resume` 与 `/sessions` 选择不再要求 idle。目标已在运行则调用 `CodingSession.refresh()` 取 host 最新内存快照；目标不在当前进程则通过会话工厂以目标 ID 打开并注册。
5. `/new` 在活动会话内创建新 ID，并重新索引 runtime；`/delete` 拒绝删除正在运行的会话，删除当前会话时重新索引新会话。
6. 命令可用性按范围区分：`clear`、`new`、`delete` 只看活动会话；`config`、`model`、`compact`、`login/logout`、`remote`、`exit` 仍要求所有会话 idle。`resume` 始终可用；恢复期间若正在压缩则显式拒绝。
7. 进程中断（SIGINT/SIGTERM/SIGBREAK）统一通过 `onInterrupt` 取消活动会话；切会话不会 dispose 共享 host，也不会取消后台 run。

## 模块边界

- `runController.ts` 只依赖 `CodingSession`、`TuiViewStore` 与领域类型；不 import Ink、React、Node 进程或面板组件。
- `runTui.tsx` 只做启动、登录/设置流程、命令/面板接线与渲染；不保存 queue 或 run 状态。
- `panelHandlers.ts` 只把面板动作翻译为控制器/配置端口调用；不判断 busy、不持有会话运行状态。
- `TuiViewStore` 仍是唯一 UI 投影 writer；后台事件不得绕过活动 `conversationId` 过滤。
- Agent 侧仍是唯一事件与 run 状态来源；CLI 不重放事件，不持久化 `activeRunId`。

## 曾考虑的替代方案

- **只删除 `/resume` 的 idle 限制**：改动最小，但全局 queue、取消目标和 view 仍共享，必然出现跨会话串台，舍弃。
- **等当前 run 结束后再恢复**：不需要新编排，但不满足“切走再切回继续看流式输出”，舍弃。
- **继续在 `runTui.tsx` 内堆 map/queue/cancel**：能工作，但 `runTui` 已承担登录、设置和面板接线，继续堆积会让组合根不可审；拆成 `TuiRunController` 并在独立测试覆盖，采用。
- **为每个会话保留独立 `TuiViewStore`**：能保存各自完整 UI 状态，但会复制通知、模型状态和面板状态，并增加多 writer；本版用活动 store + host 快照，暂不采用。
- **引入 durable run 所有权与事件日志**：可跨进程恢复在途 run，但这是另一套执行架构，会与“事件/状态只有一套来源”的现有约束冲突；本次明确不做。

## 后果与防回退

- 支持：同一 CLI 进程内 A 运行中切到 B、B 继续发送、再切回 A 查看最新流式内容；Esc 只取消当前会话；后台完成不覆盖前台 phase。
- 不支持：进程退出或更换 Agent host 后恢复在途 run；持久化只恢复为 `interrupted` 的 checkpoint。跨进程 durable run 必须另立 Note。
- 切回依赖 `CodingSession.refresh()` 的最新快照；不读取历史事件流。任何新增会改变这一语义的实现必须先补 Note 与测试。
- 后台完成不会自动把用户拉回该会话；只有错误会发通知。避免新增“自动切回”或第二套 phase。
- `/model`、`/config` 仍是全局 idle-only；不要把活动会话的模型切换误改成可影响后台 run。
- 任何新增会话级命令都必须声明 access scope，并在 `runController` 判断目标会话 busy。

## 验证

- `runController.test.ts` 覆盖：切回运行中会话取最新快照、后台完成不改前台 phase、Esc 只取消活动会话、`/new` 重索引、删除运行中会话被拒绝。
- `runTui.test.ts` 保留 panel 恢复到已存会话、命令接线与原有运行/压缩/取消行为；`viewStore.test.ts` 覆盖后台 snapshot/event 过滤与切换 revision 重置。
- `apps/cli`：59 个测试文件、378 个测试通过；`pnpm --filter @answra/cli typecheck` 通过。
- `pnpm verify` 通过：全仓 lint、Note 提示、全包 typecheck、全部测试、架构守护与设计令牌检查均通过。
