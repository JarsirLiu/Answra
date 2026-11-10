# Note：通用对话注入运行环境上下文

状态：已实施

## 问题

通用对话已经授权文件与 shell 工具，但 system prompt 原本只有 profile 提示词和 `# 工作区` 段。平台、操作系统和实际执行的 shell 只存在于工具 schema 与执行器代码里，模型看不到「当前是 Windows PowerShell 还是 POSIX shell」，容易沿用训练数据里的 bash 习惯，例如 `export`、heredoc、`/bin/sh`、Unix 路径或不存在的 GNU 参数。工作区段只回答「目录在哪里」，不能回答「命令由什么解释」。

ZCode 在 `apps/zcode-cli/packages/core/src/context/sections/env-info.ts` 中构建 `# Environment` system section，注入 cwd、是否 git 仓库、platform、shell、OS version 和当前模型；shell 显示名来自 session 的实际 shell 选择，提示词与执行层共用同一份事实。Answra 已有工作区事实，但缺少平台与 shell 事实。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/conversation/turn/environmentContext.ts`（新增）：生成 `# 运行环境` 系统提示片段。
  - `apps/agent/src/core/tool/builtin/shell/runtime.ts`：新增 `resolveShellRuntime`，让提示词与真正执行的 shell 共用同一来源。
  - `apps/agent/src/core/tool/index.ts`：通过 `core/tool` 公开入口导出 shell runtime 描述。
  - `apps/agent/src/conversation/agent.ts`：在工具型 profile 的 system prompt 中追加环境段。
  - `apps/agent/src/core/tool/builtin/shell/tools.ts`：`RunCommand` 描述对齐 Windows PowerShell 5.1。
  - `apps/agent/src/conversation/README.md`：补充环境段职责。
- 测试：
  - `apps/agent/test/conversation/turn/environmentContext.test.ts`（新增）
  - `apps/agent/test/core/tool/shell/runtime.test.ts`（扩展）
  - `apps/agent/test/conversation/application.test.ts`（对话集成断言）
- UI/进程/协议/持久化表面：
  - 不新增 IPC，不修改 worker 线协议，不持久化环境段，不改变工具执行权限。
- 相关 Note：
  - `2026-11-07-conversation-workspace-system-context.md`
  - `2026-11-09-tool-description-and-workspace-prompt-style.md`
  - `2026-11-09-shell-tools-and-session-runtime.md`
  - `2026-11-10-conversation-time-context.md`

## 决定

在工具型 profile 的 system prompt 中，按以下顺序追加：

1. profile 静态提示词
2. `# 运行环境`
3. `# 工作区`

Windows 示例：

```text
# 运行环境
- 操作系统：Windows（win32 10.0.22631 x64）
- Shell：Windows PowerShell 5.1 (powershell.exe)
- 命令语法：使用 PowerShell 语法；不要使用 bash/sh 专有语法，路径按 Windows 规则书写。
```

POSIX 示例：

```text
# 运行环境
- 操作系统：Linux（linux 6.8.0 x64）
- Shell：/bin/bash
- 命令语法：使用 POSIX shell 语法。
```

事实来源固定为：

- 操作系统：`process.platform`、`os.release()`、`os.arch()`。
- Shell：`resolveShellRuntime()` 的结果。
  - Windows 固定 `powershell.exe`，显示名 `Windows PowerShell 5.1 (powershell.exe)`；不读取 `SHELL`，也不猜测 Git Bash。
  - POSIX 使用 `$SHELL`；未设置或为空时回退 `sh`。
- 不注入环境变量、用户主目录、文件树、git 状态或任何凭据。

环境段每次 `AgentDefinition.prepare` 生成，不写 transcript、不持久化；只有授权了工具的 profile 获得该段，Answer 与 Interview profile 不获得。环境段只陈述事实，不列举工具能力，不出现 `Read`、`Grep`、`RunCommand` 等工具名。

明确不加入 Git 快照、分支、dirty 状态、模型名、文件树或自动 Git Bash 切换。git 快照需要额外命令、错误处理和隐私评估，本次不扩大范围。

## 影响表面

- 通用对话的模型请求新增平台、shell 和 OS version；这些信息会随请求发送给用户当前配置的模型服务。
- 工作区更换不影响平台与 shell；环境段仍然每轮重新生成。
- 截图答题与面试自动回复的提示词不变。
- 工具执行行为不变；只是让模型在调用前就知道实际 shell。
- 当前没有远程 Agent；Agent 与 desktop 运行在同一台用户机器上，因此进程事实就是用户设备事实。

## 模块边界

- 环境文案属于 Conversation 的模型上下文，放在 `conversation/turn/`。
- 「实际使用哪个 shell」属于工具执行事实，放在 `core/tool/builtin/shell/runtime.ts`；Conversation 通过 `core/tool` 公开入口读取，不复制判断逻辑。
- 环境段不经过 desktop；desktop 仍然只下发工作区根目录。
- 当前没有远程 Agent；未来若增加远程 sidecar，平台与 shell 不能再默认为用户本机事实，需要由客户端注入运行环境，届时另立提案。

## 曾考虑的替代方案

- **只保留现有工具描述：** 舍弃。工具 schema 已经说明 Windows 使用 PowerShell，但模型仍按 Unix 习惯生成命令；系统上下文缺少同一事实，工具描述无法承担环境说明。
- **把平台和 shell 写进静态 profile：** 舍弃。平台和 shell 随运行环境变化，静态提示会持续撒谎。
- **在环境文案里复制一套 shell 判断：** 舍弃。提示词可能显示 PowerShell，实际执行却换成其他 shell；必须和执行层共用 `resolveShellRuntime`。
- **完全对齐 ZCode，加入 git 快照和模型名：** 暂缓。git 快照需要额外命令、超时和隐私处理；模型名属于模型路由事实，不是用户工作环境，先不混入。
- **由 renderer 传入环境字符串：** 舍弃。环境是进程事实，不应接受 renderer 任意注入，也不应让 UI 承担平台判断。
- **对所有 profile 注入：** 舍弃。Answer 与 Interview 不执行 shell 或文件工具，注入环境只会增加无关上下文。
- **未选择工作区时不注入环境：** 舍弃。用户仍可能询问「你运行在什么系统」，环境事实与工作区是否选择无关；工具型 profile 始终注入。

## 后果与防回退

- shell 事实只能来自 `resolveShellRuntime`；`buildShellInvocation` 与 `# 运行环境` 共用它，禁止在提示词或工具描述里另写一套平台判断。
- Windows 环境显示名固定为 `Windows PowerShell 5.1 (powershell.exe)`；若未来改用 `pwsh`，提示词、工具描述和执行层必须同时修改。
- 环境段只陈述平台、OS 和 shell，不写 git 状态、模型名、文件树或环境变量；新增字段前先确认它属于用户运行环境而不是模型路由或工作区内容。
- 环境段只对工具型 profile 注入；新增 profile 时不要把环境事实复制到静态提示词。
- 当前 Agent 与用户同机是时区和环境事实成立的前提；远程 sidecar 会破坏该前提，必须重新设计来源。

## 验证

- `environmentContext.test.ts`：Windows/POSIX 文案、未知平台回退、环境段不出现工具名。
- `runtime.test.ts`：Windows 忽略 `SHELL`、POSIX 返回配置 shell、`buildShellInvocation` 与 resolver 的 executable 一致。
- `application.test.ts`：通用聊天请求包含 `# 运行环境`、`Shell：` 和 `命令语法：`，且顺序在工作区段之前；Answer 请求不包含环境段。
- 命令：`pnpm --filter @answra/agent exec vitest run test/conversation/turn/environmentContext.test.ts test/conversation/turn/timeReminder.test.ts test/core/tool/shell/runtime.test.ts test/conversation/application.test.ts`（49 项通过）。
- `pnpm --filter @answra/agent typecheck`、`pnpm lint` 通过。
- 全量 `pnpm --filter @answra/agent test` 中 395 项通过；6 个既有 shell 进程树/会话用例因 PowerShell 启动和 5 秒测试超时失败，另行跟踪，不属于本次环境上下文改动。
- 真实模型 function calling 与「Windows 下实际生成 PowerShell 命令」尚未人工验收；自动化只证明请求包含预期环境事实。
