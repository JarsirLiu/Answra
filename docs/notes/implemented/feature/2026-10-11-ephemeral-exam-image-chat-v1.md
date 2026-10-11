# Note：笔试截图一次性图片对话 V1

状态：已实施

## 问题

笔试截图回复工作流此前没有真实模型调用。用户需要把截图和补充文字发给 OpenAI-compatible 模型，并看到流式回复；每次发送必须独立，不建立可恢复会话，也不保存对话或图片。

## 涉及范围

- 代码/模块：`apps/app/src/conversationRuntime.ts`、`apps/desktop/src/main/conversation/`、`packages/shared/src/channels.ts`、`packages/ui/src/app/useConversationChat.ts`
- UI/进程/协议/持久化表面：截图回复条、AI 聊天面板、DesktopBridge IPC、Electron utility process；模型配置可保存，对话内容和媒体不保存。
- 相关 Note：[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)、[Electron 捕获保护版本兼容](../../implemented/bug-fix/2026-10-11-electron-capture-protection-compatibility.md)

## 决定

模型调用使用 AI SDK 6 `streamText` 与 `@ai-sdk/openai-compatible`。界面使用 `@ai-sdk/react` `useChat` 管理临时消息展示与流状态，通过自定义 `ChatTransport` 接入 DesktopBridge，不开放本地 HTTP 端口。Pi、CopilotKit、AG-UI 均不进入 V1。

每次发送生成唯一 `runId`，Agent 只构造一条本次用户消息，其中可含文字和最多 8 张图片。UI 中保留的消息只为当前打开表面显示，transport 明确忽略先前 UI 消息；关闭聊天面板或截图回复工作流时清空消息。worker 完成、失败、取消或退出时释放对应的 `AbortController`。对话、图片和模型回复不写入本地文件或数据库。

`apps/app` 提供不依赖 Electron 的运行时逻辑。desktop main 以 Electron `utilityProcess` 运行平台 worker，沿用已验证的 Electron `29.4.6` 内嵌 Node；preload 只暴露类型化配置、发送、取消和事件接口。模型地址、名称和可选 API Key 是唯一持久化数据，密钥仍通过 `safeStorage` 加密。

## 影响表面

- 笔试截图回复条可发送截图与补充文字，回复以流式方式显示；取消会终止当前请求，关闭后清除临时消息状态。
- AI 聊天面板可直接发送文字、截图并显示模型回复；连续提交是独立请求，不会把前序内容带给模型。
- 设置面板增加 OpenAI-compatible 服务地址、模型名称和可选 API Key。当前仅支持 Chat Completions 兼容接口，不含工具、MCP、语音、上下文压缩和云订阅。
- Electron 29.4.6 的隐身/捕获保护策略不变；V1 worker 运行于 utility process，不改变窗口 HWND 与内容保护调用。

## 曾考虑的替代方案

- **Pi Coding Agent / Pi Agent Core：** 要额外携带 Node runtime 或提高 Electron 版本，会增加约 85 MB 基础体积或触碰已验证的隐身基线；用户明确放弃 Pi，因此不采用。
- **CopilotKit 与 AG-UI：** V1 只有桌面 UI 到本地运行时这一条链路，新增协议映射不能减少首发实现量；保留 AI SDK 原生 `useChat` 和自定义 transport。
- **持久化多轮会话：** 与每次截图发送独立、使用后丢弃的产品要求冲突，不采用。
- **renderer 直连模型服务：** 会将 API Key 和网络职责放进 UI，因此请求在 utility process 内执行。
- **独立 Node 子进程/sidecar：** 能进一步隔离 Agent，但需要随应用打包额外 Node；Electron 29 内嵌 Node 满足当前 AI SDK 依赖，因此采用 utility process。

## 后果与防回退

- 运行时不能新增 transcript 文件、数据库记录、日志正文或自动恢复能力；若产品未来需要历史会话，必须另写 Note 决定数据所有权、保留期限和删除行为。
- transport 只能从 `messages` 中提取最后一条 user message；不得将 `useChat` 的展示历史原样发给模型。
- 图片只允许 PNG、JPEG、WebP、GIF；单图最大 8 MiB、单次最多 8 张，main 与运行时均校验。图片只经内存 IPC 和模型请求，不落盘。
- Electron 必须保持 `29.4.6`，任何运行时依赖变更先检查 Node engine，并重新执行 Windows 隐身实测。
- 关闭面板/回复工作流、取消和 worker 退出都需要清掉活动运行与临时 UI 消息。

## 验收标准

- 设置一个 OpenAI-compatible Chat Completions 服务后，笔试截图可以提交图片与文字并收到流式回复。
- 连续发送的第二个请求只包含第二次文字/图片。
- 取消或完成后活动运行数为零；不支持或过大的图片在开始运行前被拒绝。
- 对话和图片不写入磁盘；仅模型连接配置可持久化。
- Electron 29.4.6 未被升级，Electron 捕获保护行为保持原样。

## 验证

- `apps/app` runtime 测试覆盖两次请求隔离、图片输入映射、图片限制、运行结束清理和取消清理。
- UI 测试覆盖截图输入、IPC 发送、流式回复及回复条取消路径。
- 已通过：app 类型检查、app 测试（3 项）、UI 类型检查、UI 测试（50 项）、desktop 类型检查、架构检查。
- 尚需在 Windows `pnpm dev` 配置实际 OpenAI-compatible 图片模型，验证目标模型的视觉输入、SSE 与取消行为；本地 mock 服务不等同于真实模型验收。

## 风险

- OpenAI-compatible 服务对图片格式、SSE 和取消的支持程度不同；服务不支持视觉时会返回明确请求失败，但需要目标 endpoint 实测。
- 首版不含重试、工具、上下文压缩或多轮会话。超时和有限重试策略应作为独立 Note 后续设计，避免重放带副作用操作。
- utility process 与主进程之间的协议是本地内部契约；扩展字段时需同步更新 shared 类型、worker 和验证。
