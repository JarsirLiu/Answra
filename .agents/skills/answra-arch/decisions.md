# 决策记录、已知偏差与验证锚点

本文件回答：为什么这么定、哪些地方还没收干净、拿什么证据核对。

## 问题（为什么需要这套速查）

仓库有 100 多份 Note，每份只解释一个决策；`AGENTS.md` 只写边界与禁止项，不写数据怎么流。改动前要把事件、状态、Bot、工具、持久化、投影六个面各自拼图；Turn/Step/SessionFrame 迁移后又换了一套词汇，旧 Note 与旧符号混在一起，定位成本高，也容易在错误的层里加代码。

## 决定

- 会话架构速查与决策记录全部放在本 skill，按主题分层；`AGENTS.md` 只保留规范与指针。
- 结构、符号或写入顺序变化时，同一笔变更更新对应文件；单点取舍仍写各自的 Note，本目录只做导航。
- 不复制 zod 字段与事件 payload（以 `packages/shared/src/schema/` 为准）；不写 UI 像素与控件契约（属于 UI 原语 Note）。

## 曾考虑的替代方案

- **只写 `AGENTS.md`：** 规范文档要短、要可执行；把时序图、状态所有权表和已知偏差塞进去会把它撑成手册，削弱规范效力。故速查独立成 skill。
- **拆成六份独立 Note：** 跨层约束（journal → frame → transcript 的顺序、游标与快照的关系）只有放在同一套文档里才看得出来；拆进 `docs/notes` 会让读者跳转拼图。故按主题分层放在 skill 内，而不是六份 Note。
- **放在 `docs/notes/implemented/architecture/`：** Note 体系适合存单点决策与复盘，不适合当日常速查入口；AI 助手也不会主动翻目录树。故速查迁到 skill，Note 只留一条落点决定。
- **用 Mermaid 画图：** GitHub 能渲染，但终端、编辑器与纯文本 review 不可读，图改动会淹没 diff。故用 ASCII。

## 已知偏差（2026-11-23 快照）

| 级别 | 偏差 | 位置 | 处理 |
| --- | --- | --- | --- |
| 🔴 | 双份 Bot/Agent 定义：旧文件只剩类型与 ID 常量，但仍在被引用 | `conversation/agent.ts`（被 `conversation/application.ts:56` 取 ID）；`coding/agent.ts` + `coding/bot.ts`（被 `coding/application.ts`、`coding/stepBinding.ts` 取类型）；新实现在 `bots/general/*`、`bots/coding/*` | 收敛到 `bots/*` 后删除旧文件 |
| 🔴 | `AGENTS.md` 仍描述已删除的 `executeRun.ts`、`sessionEventProjector`、`conversation/turn` 回合认领 | `AGENTS.md` | 随迁移收尾同笔更新 |
| 🟡 | 旧 envelope 与 `eventRevision` 残留 | `packages/shared/src/schema/events.ts` | 迁移 3d-2/3d-3 删除 |
| 🟡 | journal 一行损坏即全量读取失败（严格 seq 连续、fail-closed） | `core/session/projection.ts` | 保留 fail-closed，另记恢复边界 Note |
| 🟡 | `TurnScheduler.finishedTurns` 不清理，长驻进程内存无界增长 | `core/session/scheduler.ts:90` | 按会话生命周期清理 |
| 🟡 | `MIGRATION_POLICY = "pre-release"` 未翻转 | `core/transcript/persistence/sqlite/migration/policy.ts` | 正式发布前改为 fail-closed |
| 🟡 | busy 语义三份副本 | `scheduler.isBusy`、answer 活动表、领域 closing 标志 | 收敛到 Scheduler |
| 🟡 | renderer live delta 无批处理，整视图每 delta 重算 | `packages/ui/src/app/useConversationView.ts` | 对齐 CLI 的 16ms 批 |
| 🟡 | 工具终态双轨（AI SDK 流的 `tool-result` 与执行钩子的 `tool-execution-finished` 都写同一 part，靠覆盖幂等） | `core/agent/providerStepRunner.ts:147`、`core/transcript/memoryStore.ts:557` | 明确单一终态来源 |
| 🟡 | `pnpm verify` 并行跑包偶发超时（单独跑全过） | vitest workspace 并发 | 调整 testTimeout 或降低并发 |

## 验证锚点

2026-11-23 逐条核对：

- `packages/shared/src/schema/session/frame.ts:9`（`SESSION_FRAME_SCHEMA_VERSION = 2`）
- `packages/shared/src/schema/events.ts:257`（`agentDurableEventSchema`，36 种）
- `packages/shared/src/schema/events.ts:263`（`agentLiveOnlyEventSchema`，4 种）
- `apps/agent/src/core/session/sessionRuntimeJournal.ts:51`（唯一写入顺序）
- `apps/agent/src/core/session/transcriptBridge.ts`（投影成功后才 `advanceLastSeq`）
- `apps/agent/src/core/session/recoveryCoordinator.ts:56`（恢复顺序）
- `apps/agent/src/core/agent/toolStepLimit.ts:8`（`MAX_TOOL_STEPS = 20`）
- `packages/ui/src/app/useConversationView.ts:67`（游标机 `seq === lastSeq + 1`）
- `apps/cli/src/tui/app/viewStore.ts:349`（CLI 复用同一 fold）

反向检查：全仓只有 `sessionRuntimeJournal.ts:60` 一处调用 `frames.publish(toSessionFrame(...))`，不存在第二条 durable 广播路径。

一致性抽查：`useConversationView.applySequential` 与 `viewStore.foldFrame` 的缺口处理都是「置 resync + 整段重读」，没有各自发明的补帧策略。

## 维护

- 新增领域、新事件组、新通道或新宿主：同步更新 `events.md`、`state.md`、`projection.md`、`navigation.md`。
- 迁移 3d 收尾（删 run 引擎、旧 envelope、旧词汇、禁词上锁）完成后：删除或改写本文件「已知偏差」中对应行。
- 本文件是带日期的快照，不要当作永久事实引用。
