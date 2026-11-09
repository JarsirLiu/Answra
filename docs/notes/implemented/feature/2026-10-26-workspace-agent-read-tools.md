# Note：对话 Agent 只读工作区工具

状态：已实施

## 问题

对话 Agent 需要按需读取和搜索笔记本工作区内容，同时工具执行必须归 Agent 进程所有，不能通过 desktop 反向请求代做。旧实现以目录枚举和读取两个 workspace 动作提供能力，但没有形成稳定工具注册与授权边界。

## 涉及范围

- `apps/agent/src/conversation/tools/`：工具定义、注册表和 Agent 内文件访问。
- `apps/agent/src/conversation/profiles.ts`、`runtime.ts`：profile 授权及 AI SDK 接线。
- `apps/agent/src/worker/`、`apps/desktop/src/main/conversation/`：workspace 根目录上下文下发。
- Agent 测试及本 Note。

本阶段只支持纯文本读取和搜索；不提供目录树工具、不写入或删除文件、不执行命令、不解析 PDF/DOCX。当前仓库没有 CLI/stdio 启动器，但 conversation runtime 和工具执行不依赖 desktop。后续已由 `2026-11-09-shell-tools-and-session-runtime.md` 开放 `RunCommand`/`WriteStdin`。

## 影响表面

- 对话模型可以调用 `Read` 读取工作区文本，或调用 `Grep` 搜索文本；读取正文会发送给当前配置的模型服务。
- desktop 只在 Agent command 中注入用户选择的根目录；工具在 Agent 进程使用 Node 文件 API 执行。
- 答题 profile 不获得工作区工具。

## 决定

- conversation 域静态注册工具。注册项绑定稳定 ID、模型名称、输入 schema 和执行器；profile 只授权 ID，runtime 仅暴露白名单工具。
- `general-chat` 授权 `conversation.read` / `conversation.grep`，分别以 `Read` / `Grep` 名称呈现。旧 `list_workspace_files`、`read_workspace_file` 已移除，目录树不注入 prompt。
- 每次 run 快照 workspace 根目录和 `AbortSignal`。Read 支持工作区内相对/绝对路径、行号及行范围；Grep 已升级为 WASI ripgrep 正则搜索，支持相对目录、glob/type、忽略大小写、上下文、分页和结构化输出。
- Read 支持任意 UTF-8/UTF-16 纯文本（含无扩展名文件），整文件上限 256 KiB，并具备 25k token 部分视图与文件状态去重；Grep 不再按扩展名白名单筛选，遵守 `.gitignore`、搜索普通点文件，并通过 worker 隔离 30 秒搜索。
- 路径支持工作区相对/绝对路径以及工作区外路径；工作区只作为相对路径基线和 Grep 默认搜索根。版本库目录继续拒绝，符号链接经 `realpath` 后按目标路径判断。普通点文件（如 `.env`）可访问。路径策略后续调整见 `../architecture/2026-11-09-workspace-default-root-not-boundary.md`；Read 质量调整见 `2026-11-09-read-tool-text-quality.md`，Grep 改造见 `2026-11-09-grep-ripgrep-tool.md`。
- 不抽取跨领域 `core/`，不建立 `FileSystemPort`；当前只有本地文件系统这一消费者。
- 写入能力必须另行定义用户确认、差异预览、并发修改检测和失败恢复后再开放。
- 不复用 Codex 的 `codex-core`。本地源码中的 Agent 核心依赖 Rust 内部 crates，并非可独立接入的 SDK；引入会增加 native/sidecar 与协议维护边界。

## 曾考虑的替代方案

- **把目录树和全部正文拼进 prompt：** 舍弃。隐式读取会放大上下文且难以审计模型实际访问内容。
- **通过 host bridge 请求 desktop 读文件：** 舍弃。Agent 脱离 desktop 后会失去核心工具能力。
- **开放 Bash：** 本阶段舍弃，因为命令执行权限远高于受限只读文件工具；后续用户明确要求移植 shell 工具，决定与风险见 `2026-11-09-shell-tools-and-session-runtime.md`。
- **建立通用工具框架或 `FileSystemPort`：** 舍弃。当前仅 conversation 一个消费者和本地文件系统一种实现。
- **本阶段实现 CLI/stdio、Glob、PDF/DOCX 或写工具：** 暂缓。它们分别属于入口、文件发现、文档解析和持久化副作用决策。

## 后果与防回退

- 新工具必须先在 conversation 静态注册，模型 schema、执行器和 profile 授权不得分散维护。
- workspace 工具不能依赖 Electron 或宿主代执行；desktop 只下发上下文。
- 版本库目录、二进制文件和资源限制由 Agent 自己强制执行；工作区外路径不再视为越界。
- PDF/DOCX 需先确认 Agent 可独立运行的解析依赖、资源边界和自动化证据。
- 工作区正文会发送给当前配置的模型服务；本轮没有修改 UI 数据流提示或工具活动展示。

## 验收结果

- Agent 自动化测试覆盖注册表授权、模型工具 schema、Read 行范围、Grep 正则/glob/上下文/分页、工作区外路径与符号链接、二进制文件、版本库目录和取消。
- 真实模型 function calling 与对话界面工具活动尚未实机验收。

## 验证

- `pnpm verify`：Biome、Note 提示、全包 typecheck、全包测试和架构检查通过；Agent 193 项、UI 229 项、desktop 277 项测试通过。
- `pnpm notes:check`：通过。
- 真实模型 function calling 与 UI 工具活动尚未实机验收；自动化验证只证明模型请求包含授权 schema，不证明具体模型服务支持工具调用。
