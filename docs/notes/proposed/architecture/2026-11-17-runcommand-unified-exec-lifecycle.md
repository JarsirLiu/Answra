# Note：RunCommand 统一执行生命周期（对齐 codex unified exec）

状态：提案

> 2026-11-17：本提案的吸收项中，Windows 一次性 Job Object、POSIX `SIGTERM → SIGKILL`、CLI 退出信号、一次性命令的 `exit` 有限排空和 marker 清理顺序已先行实施，见 [Shell 一次性命令的 Job Object、POSIX 终止升级与 CLI 退出信号](../../implemented/bug-fix/2026-11-17-shell-signal-and-job-containment.md)。统一执行路径、会话输出收口和会话语义仍待实施。

## 问题

`RunCommand` 是模型可见的唯一 shell 工具，CLI 与桌面端共用同一套实现，并明确保留可续接会话。但当前内部仍按 `yieldTimeMs` 分成两条执行路径：

- 不带 `yieldTimeMs`：`LocalShell.run` 一次性执行（`builtin/runCommand/process/oneShot.ts`）。
- 带 `yieldTimeMs`：`ShellSessionManager.start` 启动会话，后续用 `sessionId` 续接（`builtin/runCommand/process/sessions.ts`）。

同一个工具、同一份模型契约，出现两套 spawn、输出收集、超时、终止和会话状态语义，已经产生可定位的缺口（1/2/6/7 已由 P0 收口，下面保留原始诊断；3/4/5 仍待统一路径）：

1. **Windows 一次性命令绕过 Job Object。** `oneShot.ts:70` 的 `buildShellInvocation` 没有传 `windowsBootstrap`，`oneShot.ts:89-95` 的 spawn 没有 marker，`oneShot.ts:150` 的 `terminateProcessTree` 也不带 marker；`processTree.ts:49-54` 因此恒为 `unknown`，只能走 `taskkill`。会话路径 `sessions.ts:368-383` 则使用 Job Object。是否传 `yieldTimeMs` 会改变 Windows 的终止可靠性。
2. **一次性命令用 `close` 收尾。** `oneShot.ts:131` 等待 `close`，而 `close` 会等 stdio 关闭；命令派生的孙进程如果继承了 stdout/stderr，根进程退出后仍可能把工具调用拖到超时。
3. **输出上限语义不一致。** 一次性命令超过 10 MiB 会终止进程树（`oneShot.ts:153-155`）；会话只标记 `outputTruncated` 并继续丢弃输出（`sessionOutput.ts:33-54`），且默认没有总超时（`sessions.ts:168-171`）。
4. **会话完成后仍保留，并可能错误显示 `completed`。** `sessionOutput.ts:99-104` 只把 `timed_out`/`cleanup` 映射为非完成状态；进程被信号杀死时 `exitCode` 为 `null`，但仍满足 `!== undefined`，模型会看到 `completed`。
5. **结束后写 `chars` 被静默忽略。** `sessions.ts:89` 只在 `!isSessionFinished` 时写 stdin；命令已退出时传 `chars` 不报错，模型会误以为输入已送达。
6. **CLI 退出的清理入口不完整。** `apps/cli/src/main.ts:90-94` 只注册 `SIGINT`；`SIGTERM`、Windows 关闭控制台或安装包父进程结束时，`host.dispose()` 和 `ShellSessionManager.cleanup()` 可能不会执行，长任务及其后代可能残留。
7. **POSIX 终止没有升级。** `processTree.ts:28-35` 只发一次 `SIGTERM` 并立即返回；`trap '' TERM` 这类命令会存活，一次性命令只能等工具超时（`tool.ts:36`，约 630 秒）。

本地 codex 仓库的 `unified_exec` 是目前最贴近本问题的参考：

- `codex-rs/core/src/unified_exec/process.rs`：单一进程生命周期，`pending`/`transcript` 输出缓冲，根进程退出后的有限排空。
- `codex-rs/core/src/unified_exec/process_manager.rs`：进程表、交互锁、输出收集、退出后移除、容量淘汰、`terminate_all_processes`。
- `codex-rs/core/src/unified_exec/oneshot.rs`：一次性命令也走同一 unified exec 生命周期，只是不返回可续接进程。
- `codex-rs/core/src/unified_exec/output.rs`：head-tail 截断和遗漏字节标记。
- `codex-rs/core/src/unified_exec/errors.rs`：`UnknownProcessId`、`StdinClosed`、`WriteToStdin` 等显式错误。
- `codex-rs/core/src/tools/handlers/shell_spec.rs`：`exec_command` 返回输出或 `session_id`，`write_stdin` 续接。

当前基线：2026-11-17 提交 `dd61a24` 后 `pnpm verify` 全绿（agent 576、UI 330、CLI 305、desktop 350，架构与 tokens 检查通过）。因此本提案处理的是潜伏的语义缺口，不是已有红灯。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/tool/builtin/runCommand/tool.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/oneShot.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/sessions.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/sessionContract.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/sessionOutput.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/processTree.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/process/workdir.ts`
  - `apps/agent/src/core/tool/builtin/runCommand/shell/runtime.ts`（只抽共用 spawn 参数，不改 shell 检测策略）
  - `apps/cli/src/main.ts`（信号覆盖与幂等触发）
  - `apps/cli/src/cli/` 中调用 `onInterrupt` 的宿主组合点（只验证幂等，不新增领域逻辑）
- 测试：
  - `apps/agent/test/core/tool/shell/`
  - `apps/cli/test/`
- UI/进程/协议/持久化表面：
  - UI 不新增解析分支；`packages/ui` 继续消费 `RunCommandOutput` 结构化快照。
  - 最终快照可能不再携带 `sessionId`；这是工具输出语义变化，不是 IPC 或持久化协议变化。
  - 不新增 `AgentCommand`/`AgentFrame`，不持久化会话，不引入桌面端代执行。
- 相关 Note：
  - [通用对话接入 Shell 命令与会话工具](../../implemented/feature/2026-11-09-shell-tools-and-session-runtime.md)
  - [Agent 工具跨平台 Shell、流式输出与空文件编辑](../../implemented/feature/2026-11-16-agent-tool-cross-platform-shell-and-edit-state.md)
  - [把 WriteStdin 合并进 RunCommand](../../implemented/architecture/2026-11-16-merge-write-stdin-into-run-command.md)
  - [Agent 工具运行时跨平台收口与目录契约](./2026-11-16-tool-runtime-portability-and-directory-contract.md)
  - [CLI shell 子进程在中断信号下的收敛与孤儿回收](./2026-11-17-shell-process-tree-interrupt-convergence.md)

本提案吸收 `2026-11-17-shell-process-tree-interrupt-convergence.md` 中的进程树、Windows Job Object 共用、POSIX 阶段升级和 CLI 信号覆盖；实施时不再单独推进那份额外方案，避免出现两套终止语义。

## 提案

### 1. 单一执行路径

新增内部 `UnifiedCommandManager`（命名可在实现时调整），由它持有进程表、输出缓冲、状态和清理；`RunCommand` 只做参数校验和模型投影。

```text
RunCommand(command)
  -> manager.start({ command, cwd, timeoutMs, yieldTimeMs })
  -> 等待最多 yieldTimeMs
  -> 已退出：返回最终结果，不返回 sessionId
  -> 仍运行：返回 sessionId

RunCommand(sessionId, chars?)
  -> manager.write({ sessionId, chars, yieldTimeMs })
  -> 写 stdin 并等待增量输出
  -> 已退出：返回最终快照，移除 session
  -> 仍运行：返回 sessionId
```

- `LocalShell` 不再作为对外执行入口；如果保留文件，只作为 manager 内部的 spawn/收集实现。
- 一次性命令和会话使用同一套 spawn 选项、同一套终止入口和同一套输出收集。
- `RunCommand` 的模型可见字段保持不变：`command`、`sessionId`、`chars`、`workdir`、`timeoutMs`、`yieldTimeMs`、`maxOutputLength`。
- 不重新注册 `WriteStdin`，不新增第二个 shell 工具。

### 2. 输出和进程状态

每个进程维护：

```text
pending      本次调用尚未返回的输出
transcript   保留到最终快照的输出
state        starting | running | exited | failed
exitCode
signal
stdinClosed
outputClosed
```

- 使用 head-tail 有界缓冲，保留开头和结尾；初版每个输出缓冲上限 1 MiB，不把 10 MiB 原始缓冲直接交给模型。
- 模型侧仍受现有 `resultBudget`（20,000 字符/字节）约束。
- 根进程退出后最多等待一个短窗口（参考 codex 的本地 150ms，按 Windows 实测可调）排空已到达输出，然后关闭输出；不等待所有继承 fd 的后代自然退出。
- 进程退出且最终输出被收集后，从进程表移除；不靠 LRU 才清理已完成会话。

### 3. 会话语义

- `sessionId` 只在进程仍运行时返回；最终结果不再承诺可续接。
- 已退出后再用 `sessionId`：返回 `unknown session`，而不是 `completed` 或空输出。
- 已退出后再写 `chars`：返回 `stdin closed`；不能静默丢弃。
- 状态从终止原因、`exitCode` 和 `signal` 共同推导：
  - 正常退出：`completed`
  - 超时：`timed_out`
  - 取消/清理：`killed`
  - 进程失败：明确错误，不伪装成正常完成
- 并发写/轮询继续串行化；保留现有 `interactionTail` 思路，或改为 manager 内的单进程交互锁。

### 4. 终止、信号和清理

- Windows：一次性命令和会话都生成同一个 Job Object marker，共用 `windowsBootstrap`、`env`、`detached` 和 `stdio` 构造；`taskkill` 只作为 containment 失败兜底。
- POSIX：`SIGTERM` 后轮询进程组，最多 2 秒；仍存活则 `SIGKILL`；再等待最多 5 秒。进程组已消失时立即返回，避免每次取消都固定等待。
- `RunCommand.dispose()` 调用 manager 的 `terminateAll()`；CLI `onInterrupt` 覆盖 `SIGINT`、`SIGTERM`（Windows 另加 `SIGBREAK`），并保证同一轮退出只触发一次。
- 任何超时、取消、输出上限或显式清理都必须终止整棵进程树，而不是只杀根进程。

### 5. 容量和淘汰

- 保留现有会话数量上限，或按实测调整；初版不为了对齐 codex 强行改成 64。
- 淘汰规则吸收 codex：保护最近使用的若干进程，优先淘汰已退出进程，跳过正在交互/发布最终事件的进程。
- 正在写 stdin 或等待输出的进程不能被另一个启动调用无提示淘汰；被淘汰时必须有显式状态或错误。

### 6. 明确不做

- 不引入 PTY、TTY resize、sandbox、approval、exec-server 或 codex 的网络代理。
- 不把 shell 工具拆成 `exec_command` 和 `write_stdin` 两个模型工具。
- 不改成 Claude-Code 的“命令转后台任务 + 读输出文件”模型；本产品仍需要 stdin 交互和 `sessionId`。
- 不引入 `tree-kill`/`execa` 等新依赖；Windows 继续使用现有 Job Object，POSIX 使用进程组。
- 不持久化 shell 会话；进程退出或 Agent 退出后不恢复。
- 不把 1 MiB 缓冲当完整输出承诺；超出部分只返回 head/tail 和省略说明。

## 模块边界

- `builtin/runCommand/` 只负责 shell 进程生命周期、输出缓冲和模型输出投影；不读写 transcript，不定义领域 prompt，不导入 `conversation`/`interview`。
- `tool.ts` 继续是唯一模型契约入口；内部 manager 不是新工具，不进入工具目录、profile 或 UI 映射。
- `processTree.ts` 仍是唯一进程树终止实现；`oneShot`/`sessions` 不得各自拼 spawn 或 kill。
- `shell/runtime.ts` 只负责 shell 选择、调用构造、解码和错误清理；不得把进程生命周期放进去。
- CLI 只负责信号注册和 `host.dispose()` 调用；不得复制 shell 会话语义。
- `packages/ui` 只展示结构化输出；不得解析 shell 文本推断状态。

## 曾考虑的替代方案

- **保留两条路径，逐条修补。** 舍弃。一次性命令和会话已经出现 Windows 终止、输出上限、完成状态和 stdin 语义漂移；继续分别修补会把同一行为固化在两处。
- **照 codex 拆成 `exec_command` 和 `write_stdin` 两个模型工具。** 舍弃。用户已经明确要求合并为一个 `RunCommand`；模型契约不变，只吸收内部生命周期。
- **照 Claude-Code 改成后台任务 + 输出文件。** 舍弃。它不支持 stdin 续接，交互式命令只能建议用户自己管道输入；与当前产品需求冲突。
- **完整移植 codex 的 PTY/exec-server/sandbox。** 舍弃。它们解决的是跨环境执行和权限，不是本轮的会话生命周期；引入后会扩大依赖和验收面。
- **只修 POSIX 终止或只补 CLI 信号。** 舍弃（作为完整方案）。它们只覆盖 P0 的一部分，不能消除一次性/会话双路径和完成状态错误。
- **保留已完成会话，供模型重复读取。** 舍弃。codex 的最终输出在观察退出的那次调用中返回；保留已完成会话会继续制造 `chars` 静默丢弃和 `completed` 误报。
- **把完整输出落盘，模型只读文件。** 暂不做。当前模型输出预算只有 20k，1 MiB 有界缓冲足够覆盖正常场景；落盘需要新的清理、权限和路径契约。
- **引入 `tree-kill` 统一三平台。** 舍弃。Windows 上它仍是 `taskkill /T /F`，弱于现有 Job Object；POSIX 也没有我们需要的阶段升级和存活探测。
- **直接照 Claude-Code 无条件 SIGKILL。** 舍弃。开发服务器和 watcher 需要 SIGTERM 清理窗口；阶段升级更适合本产品。

## 验收标准

- 可观察结果：
  - 短命令在等待窗口内完成，直接返回最终输出和退出码，不产生可续接 `sessionId`。
  - 长命令返回 `sessionId`；续接调用返回增量输出；进程退出后最终快照不再可续接。
  - 已退出后再用 `sessionId`，模型收到明确 `unknown session`；再写 `chars`，收到 `stdin closed`。
  - 命令派生继承 stdout/stderr 的孙进程时，根进程退出后有限时间内返回，不挂到工具超时。
  - 一次性命令和会话在输出上限、超时、取消和状态显示上语义一致。
  - Windows 一次性命令和会话都生成 Job Object marker；POSIX `trap '' TERM` 命令在 2 秒后被 SIGKILL 收掉。
  - CLI 收到 `SIGTERM`/`SIGHUP`/`SIGBREAK` 时当前 run 被取消，shell 子进程及后代被清理。
- 自动化验证：
  - `apps/agent/test/core/tool/shell/` 新增统一路径、输出排空、已完成会话、stdin closed、状态推导、容量淘汰和进程树测试。
  - Windows 专用 Job Object 断言继续显式按平台跳过，不伪装成跨平台测试。
  - `apps/cli/test/` 新增 `onInterrupt` 信号注册与幂等触发测试。
  - `pnpm --filter @answra/agent test`、`pnpm --filter @answra/cli test`、`pnpm verify` 通过。
- 需要的实机验证：
  - Windows 11：PowerShell 5.1 与安装 `pwsh` 两种环境，普通命令、长命令、中文输出、超时、取消、关闭终端、`taskkill` 不带 `/f`。
  - POSIX：`trap '' TERM`、进程组终止、父子孙进程回收。
  - macOS：当前仓库无实机/CI 证据；至少需要一次 zsh 实机抽查后再宣称 macOS 行为已验证。

## 风险

- **完成会话语义变化。** 模型或 UI 可能假设 `sessionId` 在完成后仍可用；需要同步更新工具描述、测试和展示回退逻辑。
- **有限排空可能丢尾部输出。** 孙进程在根进程退出后延迟写出的内容可能不再收集；这是避免挂死的显式取舍，正常前台命令不受影响。
- **1 MiB 缓冲可能截断长输出。** 当前模型侧本来只接收 20k；截断行为必须带省略标记，不能假装是完整输出。
- **POSIX 阶段升级引入最多 2 秒延迟。** 进程组正常响应 SIGTERM 时必须快速返回，不能每次取消都等满。
- **Windows Job Object assign 可能失败。** 受限宿主（CI、部分沙箱）下仍需 `taskkill` 兜底，并保留 marker 的失败反馈。
- **双路径合并是较大内部重构。** 需要先补行为测试，再迁移实现；不能在同一提交里顺手改工具 schema、UI 展示或权限模型。
- **CLI 信号覆盖会改变退出时序。** 收到 SIGTERM 后先取消并清理，进程可能比默认行为晚退出；这是用退出延迟换孤儿回收。
- **没有 PTY。** 依赖 TTY 的交互式程序仍不能完整工作；本提案只统一现有 pipe stdin 会话，不承诺 TUI 程序。
- **没有 macOS 证据。** 现有 CI 与实机覆盖不足；不能把 Windows/Linux 的进程树测试结果外推到 macOS。
