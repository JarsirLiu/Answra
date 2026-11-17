# Note：CLI shell 子进程在中断信号下的收敛与孤儿回收

状态：提案

> 2026-11-17：本提案的进程树、Windows Job Object 共用、POSIX 阶段升级和 CLI 信号覆盖已并入 [RunCommand 统一执行生命周期](./2026-11-17-runcommand-unified-exec-lifecycle.md)；实施以该提案为准，避免两套终止语义。

## 问题

CLI 的 `RunCommand` 已经是任意命令执行入口，模型可以启动 `pnpm dev`、测试 watcher、本地 server 这类长期进程，也可以启动再派生 Node、Python、`sh -c` 孙进程。用户按 Ctrl-C、关闭终端、或安装包由父进程结束时，如果只回收根进程，这些后代就会变成孤儿，继续占用端口、文件锁和 CPU，用户很难定位来源。

现有实现已经覆盖了「一次工具调用内的终止」：超时、AbortSignal、输出超限三种路径都会调用 `terminateProcessTree`，POSIX 用进程组、Windows 会话用 Job Object。缺口在**信号进入进程这一层**：`apps/cli/src/main.ts:90-94` 的 `onInterrupt` 只注册了 `SIGINT`；Windows 上关闭控制台窗口、`taskkill` 不带 `/f`、以及 `ELECTRON_RUN_AS_NODE` 宿主被父进程结束时，进程收到的是 `SIGTERM` 或直接终止，此时 `host.dispose()` 不会执行，`ShellSessionManager.cleanup()` 也就不会跑。

需要先纠正两个常见的误判，避免把修复范围扩大：

- **「SIGINT 后 `runOnce` 会挂死、`finally` 不执行」不成立。** `cancel()` → run abort → `runWithToolTimeout`（`apps/agent/src/core/tool/executor/timeout.ts:36`）通过 `Promise.race([run, timeout, cancelled])` 立刻 reject，工具落 `executeToolCall` 的 catch，`session.wait(runId)` 正常返回，`codeCommand.ts:95-100` 的 `finally` 必然执行。
- **「`CodingHost.dispose()` 里的 `void tools.dispose()` 会让进程先于清理退出」不成立。** `ShellSessionManager.cleanup()`（`sessions.ts:178`）会 `await Promise.all(... waitForShutdown)`，上限 5 秒；整个 CLI 路径没有任何 `process.exit()` 调用，只写 `process.exitCode`（`main.ts:96`、`codeCommand.ts:94`），残余的 child 句柄会保持 event loop 存活，cleanup 等得到。参照项目 Claude-Code 之所以需要 `forceExit` + failsafe timer，是因为它有 MCP 连接、analytics flush 这类可能挂住的网络清理；我们这里的清理是本地的 `rm` 和进程探活。

因此本提案只收敛两件事：**信号覆盖面**与**终止的确定性**。也让一次性命令与会话在 Windows 上共用同一条 Job Object 路径，消掉内部的第二套实现。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/main.ts`：`onInterrupt` 注入点从单 SIGINT 扩为 SIGINT + SIGTERM（win32 增加 SIGBREAK）。
  - `apps/cli/src/cli/dependencies.ts`、`apps/cli/src/cli/codeCommand.ts`、`apps/cli/src/cli/remoteSessionCommands.ts`：`onInterrupt` 契约不变，只是被调用次数变多；需要保证多次触发幂等。
  - `apps/agent/src/core/tool/builtin/shell/processTree.ts`：抽出 Windows Job bootstrap 的共用构造；POSIX 终止加阶段升级与存活探测。
  - `apps/agent/src/core/tool/builtin/shell/localShell.ts`：Windows 分支接入 Job Object 与 marker，与会话路径一致。
  - `apps/agent/test/core/tool/shell/`：新增进程树终止与信号收敛的测试。
- UI/进程/协议/持久化表面：
  - 进程：改变 CLI 对 SIGTERM/SIGBREAK 的响应；改变 POSIX 一次性命令的终止时序（SIGTERM → 超时 → SIGKILL）。
  - 协议：不触及 `AgentCommand` / `AgentFrame`。
  - 持久化：无。
  - UI：无可见变化；退出码语义需要明确（信号导致的退出保持 `process.exitCode` 现状，不主动改写）。
- 相关 Note：
  - [Shell 工具与会话运行时](../../implemented/feature/2026-11-09-shell-tools-and-session-runtime.md)
  - [Shell 会话等待在中止/超时后及时唤醒](../../implemented/bug-fix/2026-11-10-shell-session-abort-wait.md)
  - [CLI Coding 模式与终端 UI 移植](../architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [Shell 进程树超时测试时序](../../implemented/testing/2026-11-13-shell-process-tree-timeout-test-timing.md)

## 提案

### 1. 信号收敛放在组合根，不放领域层

`main.ts` 的 `onInterrupt` 目前是「注册一个 handler，返回注销函数」，上游语义是「用户想中断当前活动」。扩展后：

```text
onInterrupt(handler) 内部注册：
  process.on("SIGINT",  handler)
  process.on("SIGTERM", handler)              // 所有平台
  process.on("SIGBREAK", handler)             // 仅 win32
  返回 () => 逐个 process.off(...)
```

- 不引入 `gracefulShutdown` 那种「调度器 + failsafe + forceExit」框架：清理是本地操作，已由 `cleanup()` 的 5 秒上限兜住，再加一层超时强制退出只会掩盖真实的清理挂起。
- 不改变 `process.exitCode` 模式：仍让事件循环自然收尾，避免 truncate `cleanup()` 的等待窗口。
- 不注册 `SIGHUP`：win32 无该信号；POSIX 上 CLI 当前不处理，且真实场景由终端关闭触发 SIGTERM/SIGHUP 之一，只加 SIGTERM 已覆盖主要路径。若要覆盖 POSIX 终端关闭，需要单独验证 vs `openBrowser` 的 `detached + unref` 子进程不会连带被杀，本提案不做。

### 2. `onInterrupt` 必须幂等

同一次退出可能连发两个信号（例如用户 Ctrl-C 后父进程再 SIGTERM）。现有调用点已经是幂等的：

- `codeCommand.ts:86-88` → `session.cancel()`，`CodingSession.cancel()` 对已结束 run 是 no-op。
- `codeCommand.ts:137` → `next.cancel()`。
- `remoteSessionCommands.ts:84-86`、`:219` → `handle.stop()` / `session.close()`，都是幂等关闭。

本提案要求在 `main.ts` 侧再加一道保护：第一个信号后把 handler 置为已触发，后续信号直接忽略，避免重复驱动 `dispose` 与重复写 snapshot。**不采用**「二次信号强制 `process.exit()`」：那会跳过 `cleanup()`，正是本提案要修的问题。

### 3. 一次性命令与会话共用 Windows Job Object

现状：`sessions.ts:485-505` 已建 Job Object 并通过 marker 反馈 containment 结果；`localShell.ts:86-92` 的 spawn 完全没有 bootstrap，`localShell.ts:146` 调用 `terminateProcessTree(state.child)` 时也不传 marker，因此 Windows 主路径恒为 `containment === "unknown"`，必然走 `taskkill /T /F` 快照枚举。

改为在 `processTree.ts` 提供一个共用构造：

```text
createWindowsJobSpawn(): { env: NodeJS.ProcessEnv, markerPath: string } | undefined
  // win32: 生成 marker 路径，返回 { env: {...process.env, [JOB_MARKER_ENV]: markerPath}, markerPath }
  // 非 win32: undefined
buildTerminatedSpawnOptions(job)  // 供 LocalShell 与 sessions 共用同一组 spawn 选项
```

- 两处 `spawn` 的 `windowsBootstrap`、`env`、`detached`、`stdio` 由同一个函数产出，避免第三套实现漂移。
- `LocalShell` 在 `close` 时清理 marker，与 `sessions.releaseJobMarker` 对齐（`sessions.ts:286-290`）。
- 保留 `taskkill` 兜底：宿主已处于受限 Job（CI、部分沙箱）时 assign 会失败，marker 写 `False`，此时仍必须能终止。

### 4. POSIX 终止加阶段升级

现状 `terminateProcessTree` 在 POSIX 上只发一次 `SIGTERM` 并立即 resolve（`processTree.ts:29-34`），不等进程真的消失。`sh -c "trap '' TERM; sleep 100 &"` 这类命令会让 SIGTERM 失效。

改为：

```text
1. process.kill(-pid, "SIGTERM")
2. 轮询 process.kill(-pid, 0) 探活，最多 2s
3. 仍存活则 process.kill(-pid, "SIGKILL")
4. 再探活最多 5s（与现有 KILL_CAP_MS 一致），超时放弃并记录
```

- 只在探活成功时升级，避免 PGID 被系统复用时误杀无关进程组。
- 返回的 Promise 改为「等进程组消失或达到上限」，`sessions.ts:299` 的 `waitForShutdown` 与 `cleanup()` 自动获得更强语义。
- Windows 侧保持「containment 成功 → `child.kill()` 后等根退出」，因为内核已经保证收割。

### 5. 明确不做

- 不新增跨平台进程管理库（`tree-kill`、`execa` 等）。Claude-Code 的 Windows 路径最终也是 `taskkill /T /F`，我们在 Windows 上已有更强的 Job Object 路径，引入依赖只会增加审计面。
- 不做全局 `cleanupRegistry` 覆盖 `clipboard.ts` / `imageAttachmentReader.ts`。它们都已有 `timeout`（`clipboard.ts:90` 的 `NATIVE_COPY_TIMEOUT_MS`、`imageAttachmentReader.ts:184` 的 `IMAGE_COMMAND_TIMEOUT_MS`），`execFile`/`spawn` 的超时由 Node 自己 kill，且都是「打开剪贴板 / 截图」这类短命命令，不是长期 server。登记进清理表收益低于复杂度。若后续出现第二个长命 CLI spawn，再单独提案。
- **不改** `transport/openBrowser.ts:15` 的 `detached: true` + `child.unref()`。浏览器进程应当比 CLI 活得久，这是设计而非缺陷；Claude-Code 的 `deepLink/terminalLauncher.ts:476` 有完全一致的 `spawnDetached`。
- 不改 `CodingHost.dispose()` 的签名。当前「dispose 返回 void、cleanup 在后台跑」依赖 event loop 保活，已验证可行；改成 `Promise<void>` 会波及 desktop 调用方，与本提案目标无关。
- 不做 PID 文件、不做崩溃后恢复、不做真正的 OS 沙箱。

## 模块边界

- `processTree.ts` 仍是唯一的进程树终止实现，`LocalShell` 与 `ShellSessionManager` 都只调用它，不再各自拼 spawn 选项。
- 信号监听只属于 `apps/cli/src/main.ts`（组合根）；`apps/agent` 不感知 CLI 信号，继续只暴露 `AbortSignal` 与 `dispose()`。
- 领域层（`coding/`）不新增清理逻辑；`ToolEntry.dispose` 仍是唯一资源收口点。

## 曾考虑的替代方案

- **引入 `gracefulShutdown` 调度器（信号统一入口 + 超时 + `forceExit`）**：舍弃。参照项目需要它是因为 MCP、analytics 等清理可能挂在网络 I/O 上；我们的清理是本地的 `rm` 与进程探活，有 5 秒上限，再加强制退出只会截断 `cleanup()` 的等待窗口，重现孤儿。
- **二次信号强制 `process.exit(130)`**：舍弃。理由同上，会跳过 `cleanup()`；代价是用户按两次 Ctrl-C 反而更容易留孤儿。
- **引入 `tree-kill` 依赖统一三平台**：舍弃。它在 win32 上就是 `taskkill /pid /T /F`，比现有 Job Object 路径弱；POSIX 上只是 `kill -SIGKILL` 广播，没有阶段升级也没有存活确认。
- **POSIX 直接 `SIGKILL`（学 Claude-Code）**：舍弃。会让 `pnpm dev` 之类命令失去清理临时文件、关闭 dev server 的机会；我们的场景常在终端里跑长任务，优雅期有价值。改为 SIGTERM → 超时 → SIGKILL。
- **为 `clipboard` / `imageAttachmentReader` 建全局 `cleanupRegistry`**：暂缓。两者已有 `timeout`，且是短命命令；先解决真正会留下长期 server 的 shell 路径。若未来出现第二个长命 CLI spawn，再单独提案。
- **在 `CodingHost.dispose()` 上改成 `async` 并 `await`**：舍弃（本轮）。需要改 `CodingSessionHost` 契约并同步 desktop 调用方，属于跨包契约变更；当前 event loop 保活已能保证 cleanup 完成，先不引入接口震荡。
- **只加 SIGTERM、保留一次性命令的 `taskkill` 路径**：舍弃。这样虽然修了主要孤儿来源，但一次性命令在 Windows 上仍依赖快照枚举，存在「枚举与后代 spawn 之间」的 TOCTOU 窗口，也与会话路径形成两套语义。

## 验收标准

- 可观察结果：
  - `answra code` 运行中向 CLI 进程发 `SIGTERM`（POSIX `kill`、Windows `taskkill` 不带 `/f`），当前 run 被取消，所有 shell 子进程及其后代消失。
  - Windows 下拉起一个再派生孙进程的命令（如 `powershell -Command "Start-Process node ..."`），终止后 `Get-Process` 中无残留、端口已释放。
  - POSIX 上使用 `trap '' TERM` 拒绝 SIGTERM 的命令，在 2 秒后被 SIGKILL 收掉。
  - 一次性命令（无 `yieldTimeMs`）在 Windows 上也走 Job Object，`ANSWRA_SHELL_JOB_MARKER` 结果为 `True`。
- 自动化验证：
  - `apps/agent/test/core/tool/shell/processTree.test.ts`：marker 解析（已有）、bootstrap 生成（已有）、新增 POSIX 阶段升级与存活探测（用可控 fake `process.kill`）。
  - `apps/agent/test/core/tool/shell/sessions.test.ts`：新增「父信号 abort 后会话与后代均消失」的集成断言（探测 PID 存活而非仅看 snapshot）。
  - `apps/agent/test/core/tool/shell/localShell.test.ts`：新增 Windows Job containment 生效断言（无 marker 时回退路径仍可终止）。
  - `apps/cli/test/`：新增 `main` 侧 `onInterrupt` 注册 SIGINT/SIGTERM/SIGBREAK 与幂等触发的单元测试（注入 fake `process.on/off`）。
  - `pnpm --filter @answra/agent test`、`pnpm --filter @answra/cli test`、`pnpm verify` 通过。
- 需要的实机验证：
  - Windows Terminal 与 VS Code 集成终端：运行长任务后关闭窗口、`Ctrl-C`、`taskkill` 不带 `/f` 三种路径下确认无残留进程与端口占用。
  - 安装包态（`ELECTRON_RUN_AS_NODE=1`）下由父进程关闭触发 SIGTERM，确认 `host.dispose()` 执行。

## 风险

- **SIGTERM 现被 CLI 吞掉。** 有些部署依赖默认行为「收到 SIGTERM 立即死」，现在会先走取消与清理。如果清理挂住，进程会比之前晚退出（上限约等于 `cleanup()` 的 5 秒 + 进程树收回的 `KILL_CAP_MS`）。这是用退出延迟换孤儿回收的显式取舍。
- **POSIX 阶段升级会引入 0–2 秒额外延迟。** 对正常响应的命令，`SIGTERM` 后轮询会很快看到进程组消失，不会等满；但实现必须让 `SIGTERM` 后进程立即退出时快速返回，否则会把每次 Ctrl-C 都拖慢 2 秒。
- **PGID 复用误杀。** 探活 + 升级扩大了「PID 被系统复用」的暴露窗口。缓解：只在 `-pid` 探活成功时升级，且窗口限制在 2 秒；仍需在实机上抽查高并发场景。
- **Windows Job Object assign 在受限宿主下会失败。** 已有 `taskkill` 兜底与 marker `False` 反馈；本提案把这条失败路径扩展到一次性命令，需要确认 CI 环境（可能已在 Job 中）不会因此变得不可用。
- **`SIGBREAK` 仅 Windows 有效。** 若在非 win32 注册会抛错，必须用平台判断包住，否则 CLI 在 Linux/macOS 启动即崩。
- **测试用真实进程。** 进程树相关断言依赖真实 PowerShell/`sh` 启动与回收，Windows 并行负载下已有偶发超时历史（见 Shell 进程树超时测试时序 Note）；新增测试必须使用显式超时而非默认 5 秒，且不能删除现有防回退断言。
- **未覆盖 POSIX 终端关闭（SIGHUP）。** 本提案只加 SIGTERM；SSH 断连、终端窗口关闭在部分终端发 SIGHUP，此时孤儿问题仍在。这是有意缩小范围，需要在后续提案中单独评估。
