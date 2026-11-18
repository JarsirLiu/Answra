# Note：Shell 进程树超时测试不再依赖 PowerShell 启动速度

状态：已实施

## 问题

全仓并行 `pnpm verify` 时，`apps/agent/test/core/tool/shell/shellTools.test.ts` 的 `terminates the whole process tree on timeout` 偶发失败：等待 `started.txt` 超时。失败不是进程树回收错误，而是测试把进程超时固定为 1 秒，同时要求父进程/孙进程在此之前启动并留下 marker。

Windows 下每次 shell 调用都要启动 PowerShell；64 个 vitest worker 并行时，启动加脚本执行可能超过 1 秒。进程在写出 `started.txt` 前就被超时终止，随后测试又等待一个永远不会出现的文件，最终以 3 秒文件等待超时失败。原测试还用固定 2.5 秒睡眠观察 marker，既不能证明进程树已经退出，也拉长了失败路径。

## 涉及范围

- 代码/模块：`apps/agent/test/core/tool/shell/shellTools.test.ts`
- UI/进程/协议/持久化表面：只调整测试时序与观察方式；不改 `LocalShell`、`processTree`、worker 协议或持久化
- 相关 Note：[Shell 工具与会话运行时](../feature/2026-11-09-shell-tools-and-session-runtime.md)、[Shell 会话等待在中断/超时后及时唤醒](../bug-fix/2026-11-10-shell-session-abort-wait.md)

## 决定

- 超时测试不再使用固定 1 秒：先执行一次 `echo ready` 测量当前 PowerShell 启动耗时，再以「启动耗时 + 2 秒」作为进程超时，最低 2 秒。
- 父进程只负责启动孙进程并把孙进程 PID 写入 `child.pid`；孙进程写 `started.txt` 后等待 `release.txt`，收到 release 才写 `leaked.txt`。因此 `started.txt` 存在即证明孙进程确实启动过。
- 超时/取消后先轮询 `process.kill(pid, 0)`，确认孙进程 PID 已退出，再写 `release.txt` 并短暂观察 marker；不再用固定 2.5 秒睡眠当作回收完成信号。
- 测试显式超时从 10 秒提高到 30 秒，给并行负载下的 PowerShell 启动和进程树回收留出空间。

## 测试范围

- `terminates the whole process tree on timeout`：验证超时结果、孙进程启动、超时后孙进程退出且 marker 不出现。
- `terminates the whole process tree when the run is cancelled`：验证取消结果、孙进程启动、取消后孙进程退出且 marker 不出现。
- 测试仍使用真实 PowerShell、真实 Node 子进程与真实进程树终止，不引入 mock 或跳过 Windows 路径。

## 曾考虑的替代方案

- **只把 1 秒超时改成 5 秒：** 舍弃。固定值仍然会与 PowerShell 启动竞争；机器更慢或并行度更高时还会复发，也不能保证孙进程在超时前启动。
- **只把文件等待和睡眠时间调大：** 舍弃。原失败发生在 `started.txt` 之前，调大等待只会让失败更慢；固定睡眠也不是回收完成证据。
- **把超时进程树测试删掉，只保留取消测试：** 舍弃。超时与取消虽然共用终止函数，但超时返回值和定时器路径仍需要独立覆盖。
- **修改生产代码让超时等待 shell 启动完成：** 舍弃。超时语义是整条命令进程的总时限，不应为测试改变；测试应适配真实的 PowerShell 启动成本。

## 验收标准

- 全仓并行测试时，超时测试不再因为 PowerShell 启动超过 1 秒而等待不存在的 `started.txt`。
- 超时和取消后，孙进程 PID 必须在观察窗口内消失；若进程树只杀根进程，`leaked.txt` 会出现并让测试失败。
- 自动化验证：目标测试连续运行 5 次通过；`pnpm --filter @answra/agent exec vitest run test/core/tool/shell` 通过；`pnpm verify` 通过。

## 风险

- 通过 `process.kill(pid, 0)` 判断进程存在，依赖操作系统在当前窗口内不复用该 PID；测试窗口只有数秒，风险可接受。
- 孙进程通过 25ms 轮询等待 `release.txt`；如果系统调度极端延迟，marker 观察窗口可能不足。当前窗口 1 秒，且只有在孙进程已退出后才写 release，主要断言仍由 PID 退出保证。
- 超时测试会增加一次 `echo ready` 预热和最长约 2 秒的额外等待，测试时间略有上升，换取并行负载下的稳定性。

## 后果与防回退

- 真实进程测试不得再把固定短超时与「进程必须在超时前启动」绑定；需要启动确认时，用 PID/文件信号等待实际启动。
- 负向断言（没有泄漏 marker）必须先等待进程退出或使用显式观察窗口，不能用一次同步读取代替。
- 如果未来 shell 启动路径增加 Job Object 引导或其他初始化，继续使用预热测量或启动信号，不要在测试里硬编码更短的超时。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/shellTools.test.ts -t "process tree"`：连续 5 次通过，两个用例耗时约 3.7 秒和 1.6 秒。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell`：通过。
- `pnpm verify`：通过。

## 2026-11-18 补充

全仓并行 `pnpm verify` 再次暴露两处同类问题：

- `spawn.test.ts` 的 Job Object marker 固定等待 5 秒；满载时 PowerShell 启动和 Add-Type 编译超过 5 秒。
- `localShell.test.ts` 把 10 秒命令超时、5 秒后即退出的后代和 8 秒墙钟断言绑在一起；满载时根 shell 未在 10 秒内退出，测试得到 `timeout` 而不是 `exit`。

补充决定：

- marker 等待改为 20 秒，测试显式超时 30 秒。
- drain 测试的后代延长到 60 秒，命令超时 30 秒，测试显式超时 45 秒；断言只检查 `exit` 与 `root done`，删除 8 秒墙钟断言；清理时按 `child.pid` 终止后代，避免残留进程。
- 仍遵循原决定：不通过延长产品默认超时掩盖问题，只给测试里的真实 PowerShell 启动和进程回收留足窗口。

验证：

- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/localShell.test.ts test/core/tool/shell/spawn.test.ts`：通过。
- `pnpm --filter @answra/agent test`：88 文件 / 669 项通过。
