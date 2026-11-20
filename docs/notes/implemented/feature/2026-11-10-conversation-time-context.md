# Note：Bot 当前时间与时区上下文

状态：已实施

## 问题

最初只有通用聊天通过 `ChatProfile.injectTime` 注入时间。Coding、Interview 等 Bot 没有当前时间，模型无法可靠回答“今天几号”“现在几点”；同时每个领域各自判断是否注入，新增 Bot 很容易漏掉。

时间属于所有对话型 Bot 共用的运行时事实，不应该由单个 profile 或领域 prompt 决定。注入机制也必须与时间文案分离：文案可测试，注入位置只有一处，未来新增 Bot 自动生效。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/currentTime.ts`：时间文案渲染与消息追加纯函数。
  - `apps/agent/src/core/agent/currentTimeContext.ts`：包装 `AgentDefinition.prepare`，在 Agent 执行边界追加时间。
  - `apps/agent/src/core/agent/runtime.ts`：`registerAgent` 注册包装后的定义，覆盖 `startRun` 与直接 `prepare`。
  - `apps/agent/src/core/agent/definition.ts`：新增 `currentTimeContext?: boolean` 显式关闭开关，默认开启。
  - `apps/agent/src/answer/agent.ts`：一次性截图答题显式关闭时间上下文。
  - `apps/agent/src/conversation/turn/modelMessages.ts`、`conversation/profiles/registry.ts`、`conversation/agent.ts`：移除 `injectTime` 与 Conversation 内的时间提醒。
  - `apps/agent/src/conversation/turn/timeReminder.ts`：删除。
- 测试：
  - `apps/agent/test/core/context/currentTime.test.ts`：时间格式、夏令时、UTC、每次重算、消息追加与不可变性。
  - `apps/agent/test/core/agent/currentTimeContext.test.ts`：包装器每次重算、runtime 默认注入和显式 opt-out。
  - `apps/agent/test/conversation/turn/modelMessages.test.ts`：移除 `injectTime` 参数。
- UI/进程/协议/持久化表面：
  - 不增加 IPC；不修改 transcript schema；不持久化时间提醒；不改变模型调用协议。
- 相关 Note：
  - `2026-11-07-domain-agent-module-registration.md`
  - `2026-11-10-conversation-runtime-environment-context.md`

## 决定

### 时间内容

时间不放进 `# 运行环境` system block，也不写入 transcript。每次 `AgentDefinition.prepare` 生成独立的 `<system-reminder>`，追加到本轮最后一条用户消息；最后一条不是用户消息时补一条用户提醒：

```text
<system-reminder>
# currentTime
Current local time: 2026-11-10 14:32 星期二 (Asia/Shanghai, UTC+08:00)
Current UTC time: 2026-11-10T06:32:00.000Z
This is the current turn time. Use it as the reference for today/yesterday/tomorrow; older messages may be from earlier times. Do not infer how long ago earlier messages were sent from message order.
</system-reminder>
```

- 本地时间使用 `zh-CN`、`hourCycle: "h23"`，输出 `YYYY-MM-DD HH:mm 星期X`。
- 同时给出 IANA 时区（如 `Asia/Shanghai`）和当前 UTC offset（如 `UTC+08:00`）。
- UTC 时间使用 `Date.toISOString()`，用于消除时区歧义。
- 明确告诉模型旧消息可能来自更早时间，且不能从消息顺序推断间隔。
- 不使用“上次对话是几小时前”这类会话间隔；本次明确不做。

### 注入位置

`AgentRuntime.registerAgent` 用 `withCurrentTimeContext` 包装定义：

- 默认每次 `prepare` 都重新生成时间，因此 `startRun`、上下文预算估算、`prepareContext` 重建和 `recoverContext` 看到同一份时间规则。
- 时间不进入静态 system prompt，避免每轮变化破坏 provider 前缀缓存。
- 内部 `AgentRuntime.generateText`（上下文摘要等）不是 Bot，不注入时间。
- `AgentDefinition.currentTimeContext: false` 是唯一关闭方式；当前只有一次性截图答题使用。新增 Bot 不写该字段即自动获得时间。

### 时区来源

当前 Agent 由 desktop 或 CLI 在本机启动，与用户在同一台机器上，因此以 Agent 进程的本地时区作为用户时区：

- IANA 时区：`Intl.DateTimeFormat().resolvedOptions().timeZone`，缺失时回退 `UTC`。
- 本地日期时间：`Intl.DateTimeFormat` 按该 IANA 时区格式化。
- UTC 时间：`Date.toISOString()`。
- UTC offset：按当前时刻从 `Intl.DateTimeFormat` 的 `timeZoneName: "longOffset"` 取值，不使用固定 `+08:00` 常量。

不同时区用户使用各自系统时区；用户旅行或修改系统时区后，下一轮自动使用新时区。历史消息只是文本，没有可回写的旧时间提醒。

当前没有远程 Agent，因此不引入客户端时区通道。未来如果增加远程 sidecar 或由客户端提供时区，再单独提案：由 desktop 或客户端注入用户 IANA 时区，Agent 不得默认使用远端主机时区。

### 明确不做

- 不计算“距上次对话几小时/几天”，不给 `ConversationMessage` 增加时间戳。
- 不把当前时间写进 transcript 或 assistant 消息，避免下次对话读到旧时间。
- 不把当前时间放进静态 system prompt；静态内容会缓存、失真。
- 不使用事件 store 的最后事件时间代替用户本地时间。
- 不要求用户手动选择时区；桌面与 CLI 直接使用操作系统时区。
- 截图答题不注入时间；它是一次性、无历史的短请求，时间没有产品价值。

## 影响表面

- Conversation、Coding、Interview intake/rehearsal 每轮都会获得当前本地时间、IANA 时区和 UTC 时间；模型回答“今天几号”“现在几点”时有明确依据。
- 新增 Bot 只要经 `AgentRuntime.registerAgent` 注册就自动获得时间，不需要改领域上下文代码。
- 截图答题保持原请求形状，不增加时间 token。
- 同一会话隔几小时或几天再发消息，时间提醒按新一轮时间重新生成；历史中的旧提醒不会被持久化。
- 不新增 transcript 字段，不改 UI，不影响现有消息展示。
- 时间提醒会把用户时区和当前时间发送给模型服务；不包含地理位置、IP 或用户身份。
- 不新增 IPC 频道；未来远程化时再定义客户端时区注入。

## 模块边界

- `core/context/currentTime.ts` 只负责时间文案和消息追加，不读取 store、不写 transcript、不知道 Agent 定义。
- `core/agent/currentTimeContext.ts` 只负责把时间追加到 `AgentDefinition.prepare` 的结果，不包含领域 prompt 或产品策略。
- `AgentRuntime.registerAgent` 是唯一注册边界，统一保证所有 Bot 都经过同一注入逻辑。
- 领域 Agent 不再拥有时间开关或时间文案；Conversation 的 `ChatProfile` 只保留提示词、历史和工具授权。
- 时间提醒只进入本次模型请求，不进入 transcript、事件 store 或持久化层。
- 若未来需要用户级时区覆盖或远程 sidecar，新增显式的 `TimeContext` 输入；不要让某个领域直接读取远端主机时区。

## 曾考虑的替代方案

- **每个领域各自调用时间 helper：** 舍弃。代码重复，新增 Bot 容易漏注入，且各领域的调用时机可能不一致。
- **继续用 `ChatProfile.injectTime` 控制：** 舍弃。开关默认关闭，新 Bot 默认没有时间；也无法覆盖非 Conversation 领域。
- **只给日期，不给时间或时区：** 舍弃。无法回答跨时区、跨天和当前时间问题。
- **把当前时间写进 system prompt：** 舍弃。system 段更适合稳定事实；每轮时间变化会破坏缓存，并可能在长期会话里留下旧值。
- **把时间提醒写入 transcript：** 舍弃。下次对话会看到历史时间，模型可能把旧提醒当作现在。
- **在 Answer 也注入时间：** 舍弃。截图答题是一次性短请求，时间对答案没有价值，还会增加无意义的输入 token；用显式 opt-out 表达这一产品判断。
- **固定 UTC：** 舍弃。用户看到的时间和系统时间不一致，跨时区体验错误。
- **要求用户设置时区：** 舍弃。操作系统已经提供，增加无必要的配置。
- **现在就让客户端传时区：** 暂缓。当前没有远程 Agent，Agent 本机时区就是用户 OS 时区；未来远程化时再设计注入协议，避免提前增加未使用的契约。

## 后果与防回退

- 时间提醒必须每轮重新生成并只追加到当前请求；不得写入 transcript 或复用上一轮 reminder。
- 新增 Bot 默认注入时间；需要关闭时只能显式设置 `currentTimeContext: false`，并在 Note 中说明产品理由。
- 相对日期必须以 `Current local time` 为基准；旧消息没有可靠时间戳，模型不得推断会话间隔。
- 时区与 offset 必须按当前时刻从 `Intl` 计算；跨夏令时和旅行不能使用固定 offset。
- 当前本机时区是 v1 的明确前提；远程 sidecar 或客户端时区注入属于后续独立决策。
- 时间文案只在 `core/context/currentTime.ts` 定义；领域 prompt 不得再复制时间说明。

## 验证

- `currentTime.test.ts`：上海本地时间与 IANA/offset、纽约夏令时冬夏 offset、UTC 格式、两次调用重新计算时间、追加到用户消息、保留已有图片 part、最后一条不是用户时新增提醒、输入不被修改。
- `currentTimeContext.test.ts`：包装器在两次 `prepare` 间重新生成时间；`AgentRuntime.registerAgent` 默认注入；`currentTimeContext: false` 不注入。
- `modelMessages.test.ts`：Conversation 上下文构建不再接收 `injectTime`。
- `application.test.ts`：通用聊天请求包含 `<system-reminder>`、`# currentTime`；Answer 请求不包含 `# currentTime`。
- 命令：`pnpm --filter @answra/agent exec vitest run test/conversation/application.test.ts test/coding/application.test.ts test/interview/application.test.ts test/answer/host.test.ts test/worker/host.test.ts`（47 项通过）。
- `pnpm --filter @answra/agent test`：91 个测试文件、690 项全部通过。
- `pnpm --filter @answra/agent typecheck`、`pnpm lint`、`pnpm notes:check` 全部通过。
- 真实模型“今天几号”和跨天重开会话尚未人工验收；自动化只证明请求包含预期时间事实。
