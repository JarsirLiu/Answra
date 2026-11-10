# Note：桌面端启动时注入用户登录 shell 环境

状态：已实施

## 问题

Agent 的 RunCommand 在自己的进程里执行 `$SHELL -c <command>`，继承的是 Agent worker 进程的环境变量。macOS 从 Finder 或 Dock 启动的 Electron 应用由 launchd 拉起，`PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`；`SHELL` 也常常不存在。结果是用户在 Terminal 里可用的 `node`、`pnpm`、`git`、`brew` 在 Agent 里全部 `command not found`，模型只能看到执行失败，无法区分是命令写错还是环境缺失。

这个缺口不会被提示词修复：`environmentContext.ts` 注入的是「Shell 是哪个」的文本事实，不能改变 `spawn` 使用的进程环境。只有从桌面主进程把真实登录 shell 的环境带进 Agent 进程，执行层才和用户终端一致。

Windows 不受影响：RunCommand 固定使用 `powershell.exe`，PATH 来自系统环境，不需要 POSIX 登录 shell 探测。

## 涉及范围

- 代码/模块：
  - `apps/desktop/src/main/userShellEnv.ts`（新增）：选择登录 shell、探测环境、解析 NUL 分隔结果、合并进进程环境。
  - `apps/desktop/src/main/index.ts`：启动时调用一次，结果写回 `process.env`，供 `utilityProcess.fork` 启动的 Agent worker 继承。
- 测试：
  - `apps/desktop/test/userShellEnv.test.ts`（新增）
- UI/进程/协议/持久化表面：
  - 不新增 IPC 频道，不改变 `AgentCommand` / `AgentFrame`，不写入 transcript，不新增配置项。
- 相关 Note：
  - [2026-11-10-conversation-runtime-environment-context.md](2026-11-10-conversation-runtime-environment-context.md)

## 决定

### 环境来源

- shell 选择顺序：`process.env.SHELL` → `os.userInfo().shell`（过滤 `unknown`）→ `/bin/sh`。
- 先探测交互登录 shell：`<shell> -il -c "env -0"`；失败（非 0 退出或异常）再退到 `<shell> -l -c "env -0"`。
- 交互探测超时（5 秒）后不再尝试登录探测，避免启动阻塞翻倍。
- nushell 直接跳过：其参数语义与 POSIX 不同，探测结果不可信。
- 输出用 NUL 分隔，避免值中出现换行或等号时解析错误；只有键和值都合法的条目才采纳。
- 探测为空（没有任何变量）视为不可用，不回退成空环境。

### 应用方式

- 只在非 Windows 平台执行；Windows 返回 `skipped: windows`。
- 探测结果由桌面主进程 `Object.assign` 写回 `process.env`，Agent worker 通过 `utilityProcess.fork` 默认继承。
- 每次应用启动探测一次；worker 崩溃重启不重复探测，避免重复阻塞主进程。
- 探测失败只记录 `[shell-env]` 日志并继续启动，不阻断应用；用户仍可通过终端启动或自行配置环境。

## 影响表面

- macOS/Linux 从 Finder/Dock 启动时，Agent 的 RunCommand 能看到与用户终端一致的 `PATH`、`SHELL` 和其他登录环境变量。
- 从终端启动的开发态行为不变（探测结果与已继承环境基本一致，仅补齐登录 shell 的额外变量）。
- Windows 行为完全不变。
- 不新增用户可见设置；不改变工具协议、事件或 UI 展示。
- 探测会把用户 shell 环境中的变量带入 Agent 进程，因此 shell 配置里注入的 `NODE_OPTIONS` 等也会生效；这是与用户终端保持一致的有意代价。

## 曾考虑的替代方案

- **在 Agent 内按需探测 PATH：** 舍弃。Agent 是 utility process，拿不到用户登录 shell 的上下文；每次命令探测会阻塞执行并重复成本，且与 desktop 平台能力边界冲突。
- **只给 RunCommand 加 `-lc` 登录参数：** 舍弃。`-l` 只加载 `.zprofile`，nvm 等写在 `.zshrc` 的 PATH 仍缺失；且 fish/nushell 语义不一致。
- **硬编码补 `/opt/homebrew/bin` 等常见目录：** 舍弃。无法覆盖 nvm、pyenv、asdf、自定义前缀，属于猜路径。
- **在提示词里告诉模型「命令可能找不到」：** 舍弃。提示词不能补执行环境，只会让模型反复重试。
- **让用户手动配置 PATH：** 舍弃。操作系统与登录 shell 已有权威来源，增加无必要配置项。
- **每次 worker 启动都探测：** 舍弃。worker 可能因异常重启，重复同步探测会反复阻塞主进程。
- **一并探测 Windows PowerShell 环境：** 舍弃。Windows 固定 powershell.exe，系统环境已够用，`-il` 参数也不适用。

## 后果与防回退

- 登录 shell 探测必须发生在 `utilityProcess.fork` 之前；若未来把 worker 启动提前到 `app.whenReady` 之前或改成独立 sidecar，需要在 fork 处显式传入合并后的 env。
- 不允许把 shell 环境探测逻辑放进 `@answra/agent`：它属于桌面平台能力，Agent 只消费继承来的环境。
- 不允许在探测失败时清空 `process.env`；必须保留既有环境继续启动。
- 交互探测必须保留 5 秒超时与「超时不再退登录探测」的行为，否则可疑的 `.zshrc` 会让应用启动卡住两倍时长。
- nushell 跳过是显式决定；若要支持 nushell，需要单独设计其 `env` 输出格式与命令语义。

## 验证

- `apps/desktop/test/userShellEnv.test.ts` 覆盖：SHELL 优先级与回退、NUL 解析与畸形条目、Windows 与 nushell 跳过、交互成功、交互超时不重试、交互失败退登录、双失败与空环境、合并时覆盖 PATH 且保留既有键、Windows 不改环境。
- 本次执行：`test/userShellEnv.test.ts` 12 项通过；`pnpm --filter @answra/desktop test` 全量 295 项通过；`pnpm --filter @answra/desktop typecheck`、`pnpm lint`、`pnpm notes:check` 通过。
- 真机验证（尚未执行）：在 macOS 上分别从 Finder 启动打包版和从 Terminal 启动，确认 RunCommand 里 `pnpm --version`、`git --version` 可执行且 `[shell-env] loaded ...` 日志出现。CI 目前只在 windows-latest 跑测试，macOS 分支需靠这条实机验证补齐。
