# Note：Shell 一次性命令的 Job Object、POSIX 终止升级与 CLI 退出信号

状态：已实施

## 问题

`RunCommand` 的一次性命令和会话路径在进程生命周期上不一致：

- Windows 一次性命令没有传入 Job Object bootstrap 和 marker；`LocalShell` 实际走 `taskkill`，而会话走 Job Object。
- POSIX 终止只发送一次 `SIGTERM`，没有探活和 `SIGKILL` 升级；忽略 `SIGTERM` 的命令只能等到工具超时。
- CLI 只注册 `SIGINT`；`SIGTERM`、macOS 终端关闭常见 `SIGHUP`、Windows `SIGBREAK` 不会触发 `host.dispose()`，shell 子进程可能残留。
- 一次性命令只等 `close` 收尾；根进程退出但后代继承 stdout/stderr 时，`close` 可能一直不来，命令结果被拖到工具超时。
- 一次性命令在 `close` 时立即删除 Job marker，终止流程可能仍在读 marker，导致本可命中的 containment 结果退化为 `unknown`。

## 根因

- `oneShot.ts` 自己调用 `buildShellInvocation` 和 `spawn`，没有复用会话的 Windows Job Object 引导。
- `processTree.ts` 的 POSIX 分支发完 `SIGTERM` 就返回，没有等待进程组退出，也没有升级信号；该文件后续已纯拆分到 `containment.ts`、`windows.ts`、`posix.ts`，语义未变。
- `apps/cli/src/main.ts` 的 `onInterrupt` 只有 `SIGINT`，平台信号适配散落在组合根。
- `oneShot.ts` 只监听 `close`，没有在根进程 `exit` 后设置有限排空窗口，也没有在排空后主动关闭残留 stdio。
- `oneShot.ts` 在 `settleShellProcess` 中先删除 marker，终止 Promise 没有与清理顺序绑定。

## 涉及范围

- `apps/agent/src/core/tool/builtin/runCommand/process/spawn.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/oneShot.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/sessions.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/containment.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/windows.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/posix.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/transport/processSignals.ts`
- `apps/agent/test/core/tool/shell/localShell.test.ts`
- `apps/agent/test/core/tool/shell/processContainment.test.ts`
- `apps/agent/test/core/tool/shell/containment.test.ts`
- `apps/agent/test/core/tool/shell/spawn.test.ts`
- `apps/cli/test/transport/processSignals.test.ts`
- `.github/workflows/ci.yml`

## 决定

- 一次性命令与会话统一通过 `spawnShellProcess` 创建进程，Windows 每次都生成 Job Object bootstrap 和 marker；`cmd` 分支没有 PowerShell bootstrap，显式回退 `taskkill`。
- POSIX 进程组终止采用 `SIGTERM → 2 秒探活 → SIGKILL → 最多 5 秒等待`。
- CLI 退出信号统一走 `onProcessInterrupt`，按平台订阅并以一次 handler 调用收口。
- 一次性命令在根进程 `exit` 后等待最多 2 秒 stdio 排空；仍未 `close` 时主动销毁残留管道并返回已收集输出。
- Job marker 清理等待终止 Promise 完成，避免终止流程读取前被提前删除。

## 修复

- 新增 `spawnShellProcess`：一次性命令与会话共用同一份 shell invocation、Windows Job Object bootstrap、marker、`cwd`、`windowsHide` 和 POSIX `detached`。
- 一次性命令监听 `child.exit`：根进程退出后启动 2 秒排空计时；`close` 先到则正常收尾，超时则销毁 stdout/stderr 并返回已收集输出；终止 Promise 完成前不删除 marker。
- POSIX `terminateProcessTree` 改为 `SIGTERM → 轮询进程组 → SIGKILL`：先等 2 秒，仍在则发 `SIGKILL`，再等最多 5 秒。
- 新增 `onProcessInterrupt`：POSIX 订阅 `SIGINT`/`SIGTERM`/`SIGHUP`，Windows 订阅 `SIGINT`/`SIGTERM`/`SIGBREAK`；同一轮只触发一次 handler，cleanup 移除全部监听。
- CLI `main.ts` 只调用 `onProcessInterrupt(handler)`，不再内联平台信号判断。
- CI 增加 `shell-macos` job，运行 agent shell 测试与 CLI 信号测试。

## 影响表面

- Windows PowerShell 一次性命令在 Job Object assign 成功时由内核收割后代；assign 失败时仍回退 `taskkill`，marker 会记录 `failed`，不会静默伪装成成功。
- Windows `cmd` 显式选择没有注入 PowerShell bootstrap，仍走 `taskkill`；不能宣称 `cmd` 具备 Job Object containment。
- 根进程退出但后代持有管道时，一次性命令最多额外等待 2 秒，然后返回已收集输出；逃出进程组的后代不会被这次返回顺带杀死。
- POSIX 命令在收到 `SIGTERM` 后最多等 2 秒；忽略 `SIGTERM` 的进程组会被 `SIGKILL`。
- CLI 收到 `SIGTERM`/`SIGHUP`/`SIGBREAK` 时也会进入既有中断清理路径。
- `RunCommand` 的模型 schema、工具名、UI 输出结构不变；`sessionId` 语义仍属于后续统一执行路径提案。

## 曾考虑的替代方案

- **只给一次性命令补 `taskkill` 参数：** 舍弃。它仍然依赖根 PID 快照，和会话的 Job Object 是两套语义。
- **只在 CLI 保留 `SIGINT`：** 舍弃。macOS 终端关闭、服务管理器终止和 Windows 控制台事件都不会覆盖。
- **POSIX 直接 `SIGKILL`：** 舍弃。开发服务器和 watcher 需要 `SIGTERM` 的清理窗口；直接杀掉会丢清理机会。
- **把 POSIX 等待时间做成无限：** 舍弃。进程组可能包含忽略信号的子进程，必须有明确上限。
- **继续在 `oneShot`/`sessions` 各写一份 spawn：** 舍弃。本次已证明两份实现会漏掉 Job Object；统一到 `spawn.ts`，后续统一 manager 继续复用。

## 后果与防回退

- 不得让一次性命令或会话重新各自拼 `spawn`；Windows Job Object bootstrap、marker 和 POSIX `detached` 只能从 `spawnShellProcess` 来。
- POSIX 路径必须保留进程组终止；不得改回只杀根进程或只发一次 `SIGTERM`。
- CLI 不得恢复只监听 `SIGINT`；新增退出信号必须走 `onProcessInterrupt`，并复用其幂等和 cleanup。
- Job Object assign 失败是合法降级，但必须保留 marker 状态和 `taskkill` 兜底；不能把 `failed` 当成功。
- 一次性命令必须保留 `exit + 2 秒有限排空`；不得回退为无限等 `close`，也不得在排空超时后继续持有 stdout/stderr。
- 会话语义收敛仍由 `2026-11-17-runcommand-unified-exec-lifecycle.md` 处理，不能在本 Note 上静默扩展。

## 验证

- 本次改动文件 targeted Biome check：通过。
- `pnpm lint`：通过，903 个文件无修改。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell`：8 个文件、82 项通过；新增用例覆盖根进程退出后后代持有 stdout 时最多 2 秒返回。
- `pnpm --filter @answra/cli exec vitest run test/transport/processSignals.test.ts test/cli/runCli.test.ts`：20 项通过。
- 本机 Windows 11 `spawn.test.ts` 观察到 Job marker 为 `failed`，走 `taskkill` 兜底；这说明测试环境不支持 assign，不代表 Job Object 路径已在本机成功。
- POSIX 的两个进程树测试在 Windows 上跳过；macOS CI job 已加入，但本次本地没有 macOS 实机证据。
- `pnpm --filter @answra/agent test`：79 个文件、580 项通过。
- `pnpm verify`：通过；agent 79 个文件/580 项、UI 47/328、desktop 53/350、CLI 51/319 通过，架构守护与 `tokens:check` 通过。

## 风险

- Windows Job Object assign 在受限宿主中可能失败，此时根进程自然退出后仍可能有后代残留；彻底解决需要父进程持有 Job handle 或额外原生能力，不在本次范围。
- Windows `cmd` 路径没有 Job Object containment，只能依赖 `taskkill`；如果后续要求全 Windows shell 一致，需要单独设计 cmd 引导。
- POSIX 进程组无法覆盖 `setsid`/daemon 化的后代；`SIGKILL` 也只保证同组进程。
- 根进程退出后仍持有管道的后代会在 2 秒排空超时后被放弃，不会被顺带杀死；这类后代需要调用方自行管理。
- 每次 Windows 一次性命令都会执行 Job bootstrap 的 `Add-Type`，有启动开销；后续统一执行路径可再评估是否缓存或替换。
- 输出上限和 `sessionId` 完成语义仍是后续阶段。
