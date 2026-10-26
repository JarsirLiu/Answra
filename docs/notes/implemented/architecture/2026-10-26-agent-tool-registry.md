# Note：对话 Agent 专用工具注册与执行系统

状态：已实施

## 问题

对话 Agent 原先在 `ConversationRuntime` 按 profile 临时拼装 AI SDK 工具；工具身份、模型 schema、授权和执行逻辑没有单一来源。一次性 `list_workspace_files` / `read_workspace_file` 也没有形成可演进的专用工具边界。

ZCode 的 `Read`、`Grep` handler 值得参考其职责和模型输入习惯，但依赖 ZCode 自有文件系统端口、权限体系与运行时 contracts，不能原样搬入 Answra。

## 涉及范围

- `apps/agent/src/conversation/tools/`：对话工具 ID、上下文、注册表、AI SDK 转换和工具实现。
- `apps/agent/src/conversation/`：profile 授权及 runtime 接线。
- `apps/agent/test/conversation/`：工具行为、授权与模型 schema 验证。
- `docs/notes/implemented/feature/2026-10-26-workspace-agent-read-tools.md`：工作区工具行为记录。

## 模块边界

- `conversation/tools/` 持有工具 ID、定义、注册表和工具执行；工具不调用 desktop，也不依赖 Electron。
- `profiles.ts` 只声明可用工具 ID；`runtime.ts` 负责按 profile 和本次 run 上下文向注册表取 AI SDK 工具。
- worker 继续只下发工作区根目录；工具实现直接使用 Agent 进程 Node 文件 API。

## 决定

- 工具系统仅属于 conversation 域，不建立跨领域 `core/`、插件发现或通用 DI 框架。
- 静态注册项绑定稳定 ID、模型名称/schema 和执行器；profile 仅列允许的 ID，runtime 根据 profile 授权构造 AI SDK 工具。
- 首批只提供 `Read` 与 `Grep` 两项只读纯文本工具，移除旧 workspace 清单/读取工具。目录树不默认注入 prompt。
- 每次 run 将 workspace 根目录快照和 `AbortSignal` 传给 Agent 工具。工具用 Agent 进程 Node 文件 API，自行校验真实路径、符号链接、隐藏目录、忽略目录和资源限制；desktop 只下发根目录。
- Read 读取行号文本及指定行范围；Grep 搜索字面文本。PDF/DOCX、Glob、Bash、写入工具和 CLI/stdio 启动器不属于本阶段。
- 不抽象 `FileSystemPort`：目前只有一种本地文件系统实现；第二个真实实现消费者出现后再评估。

## 曾考虑的替代方案

- **继续由 runtime 手工拼装工具：** 舍弃。schema 与授权会随工具增加而分散。
- **搬运 ZCode handlers/contracts：** 舍弃。其内部端口和权限/运行时 contracts 不是独立复用模块。
- **开放 Bash 代替专用工具：** 舍弃。命令执行权限远高于文件读取。
- **由 desktop 提供工具执行：** 舍弃。Agent 改由 CLI 调用时会失去工具能力。
- **现在建立 FileSystemPort：** 舍弃。当前没有第二种实现消费者。

## 后果与防回退

- 未授权工具不得暴露给模型；schema 与执行函数来自同一注册定义。
- workspace 工具在 Agent 进程执行；模型路径相对于本次 run 根目录，越界和符号链接逃逸必须拒绝。
- PDF/DOCX 进入 Read 前，需确认解析依赖、资源边界及 Agent 独立运行证据。

## 验证

- Agent 测试覆盖注册表授权、模型 schema、文件读取与搜索、路径边界、取消和资源上限。
- `pnpm verify`：Biome、Note 提示、全包 typecheck、全包测试和架构检查通过；Agent 105 项、UI 268 项、desktop 284 项测试通过。
- `pnpm notes:check`：通过。真实模型实测尚未完成。
