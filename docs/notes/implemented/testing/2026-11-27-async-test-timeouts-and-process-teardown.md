# Note：异步 UI 与子进程测试的等待标准

状态：已实施

## 问题

`pnpm verify` 在并发 CI 下出现过两次失败，单独跑同一批用例却通过：

- `packages/ui/test/InterviewOnboardingPanel.test.tsx` 的一例失败，耗时比单独跑短，像是某个异步等待先到期；
- `apps/agent/test/core/tool/shell/sessions.test.ts` 的 teardown 报 `EBUSY: resource busy or locked, rmdir '...answra-shell-session-*'`。

把这类失败归为「偶发、重跑即可」是不合格的：流水线里会反复红的测试等于没有测试。需要找到可复现的测试标准缺陷并消除，而不是放宽断言或忽略失败。

## 涉及范围

- `packages/ui/test/setup.ts`：全局设定 testing-library 的 `asyncUtilTimeout`。
- `apps/agent/test/core/tool/shell/sessions.test.ts`：留下常驻子进程的用例在用例内显式结束会话；删除工作区失败时按路径结束孤儿进程；输出截断用例改为轮询等待完成。
- 不修改产品代码、不改断言内容、不改门禁命令。相关背景：[当前时间偏移跨平台确定性](../bug-fix/2026-11-27-current-time-offset-format-is-platform-deterministic.md)、[并发负载下清理孤儿进程](../bug-fix/2026-11-27-shell-session-test-orphan-cleanup.md)。

## 决定

1. UI 测试把 `asyncUtilTimeout` 从默认 1000ms 提到 10000ms，仍小于 `vitest.config.ts` 的 15s 用例上限；断言仍是精确的 `findBy*` / `waitFor` 条件。并发门禁实测 5000ms 仍会把慢渲染误判为失败。
2. 启动 `setInterval` 常驻进程的用例在断言完成后显式 `await manager.kill(sessionId)`，不让 teardown 去赌进程是否已退出。
3. 凡以「一次 `start()` 的固定 yield 后必须 `completed`」为前提的用例，改为 `waitForCompletion()` 轮询到终态；yield 只是取首帧，不是完成保证。
4. Windows 并发负载下 Job Object 兜底可能失效，删除临时目录前按工作区路径精确结束残留的 node 孙进程。

## 测试范围

- 所有 UI 用例的 `findBy*`、`waitFor` 等待预算：10s，仍会因真实回归失败。
- Shell 用例的 `waitUntil` 轮询预算：10s（原 3s 在并发下不够 PowerShell 引导 + 脚本落标记）。
- Shell 会话用例中启动长期存活子进程的用例：用例结束前必须终止，工作区 CWD 才不会占着临时目录。
- 不覆盖产品进程树终止的超时策略；那是另一层边界，本轮先保证测试不把自己的进程留给 teardown。

## 修复

- `setup.ts` 用命名常量 `ASYNC_UTIL_TIMEOUT_MS = 10_000` 全局配置；注释写明「只放宽等待预算，断言不变」。
- `waitUntil` 默认预算从 3s 提到 10s，供 `cleanup terminates a running process tree` 等待 `ready.txt` 落盘。
- `does not apply a default timeout to a persistent session` 在 `status: "running"` 断言后调用 `manager.kill(requireSessionId(started))`，并注明 Windows 下存活子进程占用工作区 CWD 会导致删除时 `EBUSY`。
- `removeWorkspace` 在可重试的删除错误后按工作区绝对路径结束残留 node 进程；只匹配命令行含该路径的进程，不碰宿主与其他测试。
- 输出截断与累计省略字节两个用例不再在 `start()` 的 5s yield 上断言完成，改为 `waitForCompletion()`；轮询沿用用例自己的 `maxOutputLength`，保证截断文案不因续读而改变。
- 面试登录提示用例在点击「发送消息」前等按钮可用：打开会话是异步的，`sending` 为真时按钮禁用，负载下直接点会被吞掉。

## 曾考虑的替代方案

- **失败就重跑或标记为 flaky：** 舍弃。掩盖不稳定，流水线仍会随机红。
- **放宽或删除对应断言：** 舍弃。测试失去对行为的约束，正是要避免的「质量不管」。
- **在用例里插入固定 `sleep`：** 舍弃。只会整体拖慢，且在更慢的机器上同样不够。
- **改产品 `cleanup()` 的 5s 终止上限：** 本次不动。先确认测试是否把自己的常驻进程清理干净；扩大产品等待面会改变运行时语义，需单独评估。

## 后果与防回退

- 新 UI 异步用例不得自带随意 `sleep`；等待用 `findBy*` / `waitFor`，由全局预算兜底。
- 任何启动常驻子进程的 Agent 用例必须在用例内显式终止；不得依赖 teardown 的 5s 上限碰运气。
- 不要把「重试删除临时目录」当作进程已退出的证明：重试只吸收句柄释放的短暂延迟，不掩盖未终止的进程。
- 若未来仍出现 `EBUSY`，应查进程树终止本身，而不是继续延长等待预算或放宽删除断言。
- 用例不得把固定 yield 当成完成信号：完成状态必须由轮询到终态的快照给出。

## 验证

- `pnpm --filter @answra/agent test`：110/110 文件、830/830 用例通过，无 `EBUSY`、无截断用例的 `running` 断言失败。
- `pnpm verify` 全量退出码 0：UI 369/369、Agent 830/830、desktop 380 passed / 2 skipped 及其余各包测试全绿，静态门禁通过。
