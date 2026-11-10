# Note：Shell 会话等待在中止/超时后及时唤醒

状态：已实施

## 问题

`writeStdin` 在长等待期间被取消时，调用方可能一直等到 yield 窗口结束才收到 `AbortError`；全量并行测试中 `cancels a writeStdin wait` 因此超过 5 秒默认测试超时。清理与容量测试也因真实的 PowerShell 启动/进程树回收耗时叠加固定等待而偶发超时。

## 涉及范围

- 代码/模块：`apps/agent/src/core/tool/builtin/shell/sessions.ts`、`apps/agent/test/core/tool/shell/sessions.test.ts`
- UI/进程/协议/持久化表面：只改 Agent 进程内 shell 会话语义；不新增 IPC、worker 协议或持久化。
- 相关 Note：`docs/notes/implemented/feature/2026-11-09-shell-tools-and-session-runtime.md`

## 决定

Shell 会话在创建时持有 `terminationStarted`，终止流程一开始就 resolve；所有等待 race 该信号而不是进入等待时捕获的终止 Promise。测试对真实进程生命周期使用显式期限，不用默认 5 秒兜底。

## 根因

`ShellSessionManager.wait` 在进入等待时捕获 `session.termination`，但该 Promise 只在 `terminate` 调用后才创建。若 abort 或 timeout 发生在等待开始之后，race 仍监听进入时捕获的 `undefined` 占位 Promise，只能等 yield 延迟到期。默认空轮询 yield 为 5 秒，正好与测试默认超时重合。

测试侧还有两个独立问题：`cleanup` 的 5 秒 shutdown cap 加 2.8 秒泄漏观察超过默认 5 秒测试超时；Windows PowerShell 在并行负载下 1 秒内不一定结束，stderr 清理测试只读一次启动快照。

## 修复

- 每个 Session 在创建时持有 `terminationStarted`，由 `markTerminated` 在进入终止流程时 resolve。
- `wait` 改为同时等待 `session.done`、`session.terminationStarted` 和 yield 延迟；abort/timeout 触发终止后立即唤醒，再由调用方执行 `throwIfSessionAborted` 或生成终止快照。
- `waitForShutdown` 继续等待实际 `termination` Promise，`kill`/`cleanup` 的资源回收语义不变。
- 测试新增 `waitForCompletion`，持续读取会话直到非 `running` 或达到期限，并累计 stdout/stderr，避免只读一次启动快照。
- 写入 stdin、工作目录和会话续接测试也循环读取到终态；shell 集成测试套件统一使用 30 秒 suite timeout，不改变生产超时。

## 曾考虑的替代方案

- **只放宽测试超时：** 舍弃。abort 在生产中仍要等最长 30 秒 yield 才返回，测试只是不再暴露问题。
- **降低 `SHUTDOWN_WAIT_MS`：** 舍弃。会缩短真实进程树回收的等待窗口，可能让清理测试通过但留下孤儿进程。
- **删除或跳过慢测试：** 舍弃。这些测试覆盖中止、清理和容量淘汰，是会话生命周期的主要防回退证据。
- **让 `wait` 直接等待 `session.done`：** 舍弃。进程树回收可能慢于用户取消，取消语义不应依赖根进程退出速度。

## 验收标准

- 取消 `writeStdin` 等待后，调用方在 abort 发生后立即收到 `AbortError`，不等待完整 yield。
- 超时终止仍返回 `timed_out`，清理仍返回 `killed`，`kill`/`cleanup` 仍等待实际终止流程。
- 全量 Agent 测试中 shell 会话测试不再因并行负载超时。
- 自动化验证：`test/core/tool/shell` 66 个测试通过；`pnpm --filter @answra/agent test` 409 个测试通过。

## 风险

- `wait` 现在在终止流程开始时唤醒，而不是等进程树完全退出；超时快照可能少包含终止瞬间的输出。终态本就表示进程已被终止，这个取舍可接受。
- 实际资源回收仍由 `termination` 与 `waitForShutdown` 负责；不能因为 `wait` 提前返回就删除 shutdown 追踪。
- 未来新增终态时必须继续走 `markTerminated`，否则 `wait` 不会及时唤醒。

## 后果与防回退

- 任何在等待开始之后发生的 abort/timeout 都必须通过 `terminationStarted` 唤醒等待，不得重新捕获进入时的 `session.termination`。
- `kill`、`cleanup` 和容量淘汰仍必须等待实际终止；提前唤醒只属于查询/取消路径。
- 真实进程、PowerShell 启动和进程树回收的集成测试需要显式测试超时；不能用固定睡眠当作完成信号。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell`：6 个文件、66 个测试通过。
- `pnpm --filter @answra/agent test`：50 个文件、409 个测试通过。
- `pnpm exec biome check`（本次涉及文件）：通过。
- 全 workspace `pnpm verify` 仍被无关问题阻断：`packages/ui/test/FloatingBarApp.test.tsx` 格式检查和既有 PDF/Word 模块声明缺失。
