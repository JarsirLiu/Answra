# Note：pre-push 门禁不再依赖错误的时间假设

状态：已实施

## 问题

连续执行 `git push` 时，husky pre-push 的 `pnpm verify` 反复失败，表现为“每次换一个用例”，但单独重跑对应测试又通过。完整日志证明这些不是单一偶发超时：

- UI 打开懒加载工作区面板后立即用 `getByRole` 断言，`lazy()` 尚未完成时必然找不到节点。
- `FloatingBarApp` 的集成测试在 47 个 UI worker 与其他包并行时耗时超过 Vitest 默认 5 秒；其中一个测试内部使用 `findByRole(..., { timeout: 10_000 })`，外层却只有 5 秒，等待上限自相矛盾。
- 复制按钮测试在 `writeText` 已调用后立即断言“已复制”文案，没有等待 React 状态提交。
- Agent 并发轮询测试在循环中只保留最后一次快照，前面轮询已经消费的 `one`、`two` 被丢弃。
- Agent stdin 会话测试只轮询一次，PowerShell 启动和脚本输出晚于单次等待窗口时结果为空。

这些测试把“固定时间”或“单次查询”当作完成信号，负载一高就稳定暴露。

## 涉及范围

- 测试配置：`packages/ui/vitest.config.ts`
- UI 测试：`packages/ui/test/FloatingBarApp.navigation.test.tsx`、`packages/ui/test/toolCallRenderers.test.tsx`
- Agent 测试：`apps/agent/test/core/tool/shell/sessions.test.ts`、`apps/agent/test/core/tool/shell/shellTools.test.ts`
- 相关 Note：[Shell 会话等待在中断/超时后及时唤醒](../bug-fix/2026-11-10-shell-session-abort-wait.md)、[Shell 进程树超时测试不再依赖 PowerShell 启动速度](./2026-11-13-shell-process-tree-timeout-test-timing.md)、[PowerShell 会话 stderr 增量清理不丢错误消息](../bug-fix/2026-11-17-powershell-stderr-incremental-cleanup.md)

## 决定

- 所有异步 UI 内容用 `await screen.findByRole(...)` 等待可访问节点，不再在触发 `lazy()` 或异步复制后立即 `getByRole`。
- `packages/ui/vitest.config.ts` 将 `testTimeout` 设为 15 秒，覆盖测试内部已有的 10 秒等待上限；15 秒仍会失败，不会无限等待。
- Agent 并发轮询测试累积 `start`、并发结果和每次循环快照，再用累计 stdout 断言 `one/two/three` 各出现一次。
- Agent stdin 测试先写入一次，再在 15 秒期限内持续轮询会话，直到累计 stdout 包含结果或会话结束。
- 不通过重试、跳过或 `--no-verify` 让门禁变绿。

## 测试范围

- UI 懒加载工作区：打开笔记本后等待“选择目录”和“笔记本 / 资料”出现，再执行收起/设置操作。
- UI 复制反馈：等待 `writeText` 调用后再等待“已复制修改后片段”按钮。
- UI 集成测试：在完整 `pnpm verify` 的并行负载下不再因默认 5 秒超时失败。
- Agent 并发轮询：覆盖输出分散在多个后续快照的情况，仍验证不重复、不丢失。
- Agent stdin 会话：覆盖 PowerShell/Node 启动超过单次等待窗口的情况，按完成信号继续读取。

## 曾考虑的替代方案

- **给失败测试加 `retry` 或直接跳过：** 舍弃。失败对应真实的测试竞态或生产流式缺陷，重试只会降低门禁可信度。
- **只把所有测试超时统一调大：** 舍弃。无法修复懒加载和复制状态未等待的问题；超时数字变大只会让错误更晚出现。
- **降低 Vitest worker 数，牺牲并行速度换稳定：** 舍弃。测试应在当前并行度下成立；通过减少并发掩盖时序假设，CI 资源变化后仍会复发。
- **允许 pre-push 使用 `--no-verify`：** 舍弃。连续失败正是门禁在暴露真实问题，跳过 hook 会把缺陷带进远端。

## 验收标准

- 连续两次完整 `pnpm verify` 通过，不依赖手动重跑单个包。
- UI 测试不再在 `lazy()` 或剪贴板异步反馈后立即断言。
- Agent 会话测试不会丢弃循环中的中间快照，也不会把一次轮询当作命令完成。
- 测试超时只作为失败兜底，不作为完成信号。

## 风险

- UI 测试超时提高到 15 秒后，真正的挂起会晚 10 秒失败；仍由测试内的明确断言和 15 秒上限兜底。
- Agent 会话轮询最多等待 15 秒；超过期限仍会失败，不会无限占用 CI。
- 若未来新增其他懒加载面板，测试仍需等待可访问节点；不能因为工作区测试修好就恢复同步断言。

## 后果与防回退

- 触发 `lazy()`、异步剪贴板或异步会话输出后，断言前必须有可观察的收敛信号；固定 `getByRole` 或单次轮询不算信号。
- 测试内部等待上限不得大于 Vitest `testTimeout`；新增更长等待时同步调整配置或改用更小的内部上限。
- 会话轮询测试必须累积每次快照；只保留最终快照会静默丢掉增量输出。
- 出现 pre-push 失败时先读完整日志定位用例，不能用连续重推碰运气。

## 验证

- UI 全量测试连续两轮：47 个文件、330 个测试通过。
- Agent shell 目标测试：`sessionOutput.test.ts`、`sessions.test.ts`、`shellTools.test.ts` 共 40 个测试通过。
- 完整 `pnpm verify` 连续两次通过：lint、typecheck、全包测试、architecture、tokens 全部通过。
- 失败复现证据：并发轮询快照显示 `one/two` 在中间轮询被消费，最终只剩 `three`；修正后累计快照断言通过。
