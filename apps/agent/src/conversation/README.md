# Conversation 领域

Conversation 负责用户与 Agent 之间的 transcript，以及一次回复回合的模型执行。目录按业务事实组织，不按 Event、Status、Store 等技术名词平铺。

```text
conversation/
  session/       会话 transcript、snapshot 恢复游标和仓储
  turn/          一次 assistant 回合的认领、模型调用、流消费和终态
  profiles/      场景提示词、上下文策略和工具白名单
  tools/         Conversation 获准工具及工作区安全边界
```

## `session/`

- `store.ts`：`ConversationStore` 仓储端口。定义创建、加载、原子认领、更新 transcript 和结束回合。
- `memoryStore.ts`：当前进程内的 transcript 仓储实现；不保存 Agent 事件或事件 journal。
- `message.ts`：把已校验的发送请求转换成 transcript 用户消息。

Session 只拥有消息和会话 revision。`run/attempt/step` 的执行状态属于平级的 `execution/` 领域。

## `turn/`

- `runtime.ts`：Conversation 组合根。暴露创建会话、发送、答题、取消和等待；负责认领回合并组装执行依赖。
- `executeTurn.ts`：已认领回合的流程组合，调用 AI SDK 并协调流、事件写入和终态收尾。
- `chatRuntime.ts`：把通用聊天 profile 接到回合入口。
- `endpointFetch.ts`：模型端点校验、云端令牌一次刷新和本地 API Key fetch。
- `errorSummary.ts`：将未知模型错误压缩成有界诊断字段。
- `modelMessages.ts`：按 profile 选择 transcript 历史、把图片输入转换成 AI SDK 消息，并注入已授权的时间提醒。
- `streamJournal.ts`：串行把模型事件交给唯一 `ExecutionStore`，并收集仅供日志使用的回合指标；名称中的 journal 不代表第二个事件日志。
- `requestContent.ts`：发送文本和图片的边界校验与 data URL 解析。
- `timeReminder.ts`：只供显式开启时间上下文的 profile 使用的系统提醒。

`turn/` 消费 `result.fullStream` 并交由 `core/model/` 转换为 shared Agent event contract；不消费 `toUIMessageStream()`，避免并列事实源。`turn/` 不定义长期执行状态；所有模型与生命周期事件写入唯一 `ExecutionStore`，UI 从同一 `AgentEventEnvelope` 流投影状态。

## `profiles/`

定义场景策略：提示词、是否读取历史、时间上下文和工具授权。它们是 Agent 内部静态注册，不接受 renderer 动态注入。

- `registry.ts`：通用聊天 profile 类型与静态注册表。
- `answer.ts`：截图答题专用策略，不使用通用聊天历史或工具。

## `tools/`

实现 Conversation 领域自己的 Read/Grep 工具、工具 registry 和工作区路径边界。工具在 Agent 进程执行，desktop 只注入获准的工作区上下文。

- `types.ts`：Conversation 工具 ID 与执行上下文契约。
- `registry.ts`：静态工具定义表；profile 授权与 AI SDK tool set 从同一组定义构造。
- `read.ts` / `grep.ts`：读取单个工作区文本文件、按字面字符串搜索文本文件。
- `workspace.ts`：工作区根目录、路径防逃逸、文本文件范围、输出大小和取消检查。

Answra 只采用按事实拆分的原则，当前仍保持单 Agent 进程和内存仓储，不预建远程服务、SQLite 或插件框架。
