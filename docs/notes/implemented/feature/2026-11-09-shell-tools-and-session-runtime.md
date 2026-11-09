# Note：通用对话接入 Shell 命令与会话工具

状态：已实施

## 问题

通用对话已具备 `Read`、`Grep`，但模型无法运行本地 CLI、测试命令或 OfficeCLI 等需要进程执行的能力。用户明确要求把 xai 已经修过的 shell 工具整体移植过来，包括一次性命令、可续接会话、进程树终止和 PowerShell 错误清理。

此前的 `2026-10-26-agent-tool-registry.md` 和 `2026-10-26-workspace-agent-read-tools.md` 明确把「开放 Bash」列为舍弃项。本次是用户显式改变产品范围，不是对旧结论的无意回退；旧 Note 保留历史理由，并由本 Note 覆盖其中「Bash 不属于本阶段」的部分。

## 涉及范围

- `apps/agent/src/core/tool/builtin/shell/runtime.ts`：跨平台调用构造、UTF-8/GBK 解码、输出截断、PowerShell 错误包装清理。
- `apps/agent/src/core/tool/builtin/shell/processTree.ts`：POSIX 进程组、Windows `taskkill` 兜底与 Job Object containment。
- `apps/agent/src/core/tool/builtin/shell/localShell.ts`：一次性命令执行、超时/取消/输出超限终止进程树。
- `apps/agent/src/core/tool/builtin/shell/sessions.ts`：可续接 shell 会话、stdin 写入、等待窗口、LRU 淘汰与 cleanup。
- `apps/agent/src/core/tool/builtin/shell/workdir.ts`：工作目录解析；工作区是默认根目录而不是访问边界。
- `apps/agent/src/core/tool/builtin/shell/tools.ts`：`RunCommand` / `WriteStdin` 工具定义与模型投影。
- `apps/agent/src/core/tool/contracts.ts`、`registry.ts`、`builtin/index.ts`：`process` 副作用域、工具资源 dispose、内置工具装配。
- `apps/agent/src/host.ts`：Agent 进程关闭时释放 shell 会话。
- `apps/agent/src/conversation/profiles/registry.ts`：`general-chat` 授权两个 shell 工具。
- 测试：`apps/agent/test/core/tool/shell/` 下的 runtime、processTree、sessions、shellTools 测试，以及 registry/builtin 授权测试。
- UI/进程/协议/持久化表面：不新增 IPC 频道，不改变 worker 线协议；shell 在 Agent utility process 内执行，desktop 不代执行。

## 影响表面

- 模型可以在当前工作区运行任意 shell 命令，并获得 stdout、stderr、退出码或超时结果；Windows 使用 PowerShell，POSIX 使用 `$SHELL`/`sh`。
- 长命令可以通过 `yieldTimeMs` 返回 `sessionId`，再用 `WriteStdin` 继续等待或写入 stdin；完成后的会话仍可复查最终增量输出。
- `workdir` 支持工作区相对路径和绝对路径，默认使用工作区根目录；工作区不是安全边界，命令本身也没有 sandbox 或审批。
- 这是最高权限的通用工具：命令可以读写工作区外文件、访问网络、启动其他进程，影响范围等于 Agent 进程权限。
- Answer 与 Interview profile 不获得 shell 工具；模型工具调用事件、transcript 和 UI 展示沿用现有链路。
- Shell 会话只存在内存中，不做持久化；Agent 进程关闭时统一清理。会话也受 32 个 LRU 上限约束。

## 决定

- 工具模型名为 `RunCommand` / `WriteStdin`，内部 ID 为 `workspace.run-command` / `workspace.write-stdin`，与现有 `Read`/`Grep` 的命名风格一致。
- 一次性命令使用 `spawn`，POSIX 让子进程成为进程组组长，Windows 用 `taskkill /T /F` 兜底；超时、取消和输出超过 10 MiB 都终止整棵树，而不是只杀根进程。
- 会话在 Windows 上先创建 `KILL_ON_JOB_CLOSE | BREAKAWAY_OK` Job Object 并 assign 根 PowerShell；containment 成功时 kill 根进程即可由内核收割后代，失败时回退 `taskkill`。containment 结果写临时 marker，不污染模型输出。
- 一次性命令和会话共用 `buildShellInvocation`、`decodeShellOutput`、`truncateShellOutput`、`stripPowerShellErrorWrapper`；PowerShell 编码前缀、Job Object 引导和退出码收尾都在同一条 `-Command` 脚本中。
- 不引入 `iconv-lite`：UTF-8 解码出现替换字符时回退到 `TextDecoder("gbk")`，避免增加 Agent 依赖。
- PowerShell 错误清理只在检测到 `Write-Error` 脚本回显、`At line`/`所在位置` 或 `CategoryInfo` 包装时生效；普通原生命令 stderr 保持原样。
- 工作目录解析使用 `realpath` 后确认目录，但不强制落在工作区内，也不排除 VCS 目录。原因是 shell 命令可以通过 `cd` 绕过任何 workdir 字符串边界，声明边界只会制造虚假安全感；工作区只承担默认 cwd。
- 会话管理器在工具注册表中全局共享，`start` 显式传入已解析的绝对 cwd，因此同一 Agent 进程内可以服务不同工作区；会话按访问顺序 LRU 淘汰，默认不设总超时，只有调用方显式传 `timeoutMs` 才计时。
- `ToolEntry` 增加可选 `dispose()`，`ToolRegistry.dispose()` 在 Agent 关闭时调用；shell manager 的 cleanup 挂在 `RunCommand` 上，避免两个工具重复清理。
- 工具元数据把副作用域标记为新增的 `process`，并设置 `destructive: true`、`concurrentSafe: false`；模型输出预算为 20,000 字符/字节，底层单流上限 100,000 字符。

## 曾考虑的替代方案

- **继续维持「不开放 Bash」：** 舍弃。旧决策的前提是只有只读文件工具；用户现在明确要求运行本地 CLI，继续拒绝会让 OfficeCLI、测试和构建类需求无法完成。
- **通过 desktop 反向 RPC 执行命令：** 舍弃。Agent 脱离 desktop 或作为 sidecar 运行时会失去工具能力，也违反「工具只在 Agent 进程执行」的既有边界。
- **把工作区继续作为 workdir 硬边界：** 舍弃。命令可以自行 `cd` 到任意目录，限制 workdir 不能阻止越界，只会让模型误以为已被沙箱保护；与 `2026-11-09-workspace-default-root-not-boundary.md` 的路径策略冲突。
- **本轮加入审批/沙箱：** 暂缓。它需要新的 UI、权限模型、超时与用户交互契约；本次只移植命令执行能力，风险在「后果」和「风险」中明确保留，不能假装已经隔离。
- **为每个会话创建独立 manager：** 舍弃。`writeStdin` 只能拿到 opaque sessionId，跨 manager 路由需要额外映射；单个 LRU manager 已经能隔离会话并提供伪造 ID 拒绝。
- **继续使用 `iconv-lite`：** 舍弃。`TextDecoder` 已覆盖当前 UTF-8/GBK 需求，且 Answra Agent 没有该依赖。
- **自动切换到 Git Bash：** 舍弃。当前只保留 PowerShell/POSIX 两条明确路径，不猜测用户安装了 Git Bash。

## 后果与防回退

- 正面后果：模型可以执行构建、测试、CLI 和 OfficeCLI；长命令可以增量读取，不再受单次前台等待限制；PowerShell 错误输出更短，进程树不会因超时/取消残留。
- 代价：这是任意代码执行能力，Agent 进程权限就是命令权限；没有审批、沙箱或网络限制。Shell 会话在进程内保留到退出/淘汰，不随会话清空自动消失。
- 防回退：
  - 不得把 `RunCommand` / `WriteStdin` 授权给 Answer、Interview 或其他不需要命令执行的 profile。
  - 不得移除超时/取消/输出超限时的整棵进程树终止；只 `child.kill()` 会重新引入孤儿进程。
  - Windows 会话必须保留 Job Object containment 与 `taskkill` 兜底；container 失败不能静默当作成功。
  - 一次性命令和会话必须继续共用 `runtime.ts`，不得恢复两套 PowerShell 前缀、编码或截断实现。
  - PowerShell 清理只移除包装信息，不得丢弃真正错误消息或原生 stderr。
  - 工作区不得被重新描述成 shell 的访问边界；命令没有 sandbox。
  - 新增 shell 会话相关资源时必须在 `ToolEntry.dispose` / `ToolRegistry.dispose` 中收口，不能依赖 GC 或进程自然退出。
  - 模型输出仍必须受字节/字符预算约束，不得把 10 MiB 原始缓冲直接交给模型。
- 后续若要加审批或 OS 沙箱，必须单独写 Note 定义用户确认、权限范围、超时和失败收口；不能在本 Note 上静默扩展。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell test/core/tool/registry.test.ts test/core/tool/builtinTools.test.ts test/conversation/turn/workspaceContext.test.ts`：7 个文件、64 项测试全部通过。
- `pnpm --filter @answra/agent test`：31 个文件、240 项测试全部通过。
- `pnpm lint`（Biome）、`pnpm notes:check`、`pnpm architecture:check`：通过。
- 覆盖：UTF-8/GBK、PowerShell 脚本回显/CategoryInfo 清理、原生命令 stderr 保留、多语句变量共享、非零退出码、输出截断、相对/绝对 workdir、无工作区失败、会话增量读取、stdin 写入、超时、无默认会话超时、取消、并发轮询串行、LRU、cleanup、短命令超时/取消的进程树回收。
- 尚未在真实桌面端模型对话中验收 `RunCommand`/`WriteStdin` 的 function calling 与 UI 工具活动呈现；自动化只证明工具契约、进程行为与模型投影。

## 风险

- Shell 没有审批或沙箱，模型可以执行破坏性命令；这是本轮有意接受的产品风险，必须在 UI/产品层继续评估是否增加确认。
- Windows Job Object 在受限宿主中可能 assign 失败，此时回退 `taskkill`；极端并发下仍存在 `taskkill` 枚举窗口，但比只杀根进程安全。
- 会话跨对话共享且不随会话清空释放，长期运行进程最多保留 32 个会话；清空对话后仍可能继续运行，直到命令结束、LRU 淘汰或 Agent 退出。
- PowerShell 5.1 的编码与错误格式仍随系统版本变化；当前清理规则有测试保护，但非中文系统/自定义 `$ErrorView` 仍需实机抽查。
