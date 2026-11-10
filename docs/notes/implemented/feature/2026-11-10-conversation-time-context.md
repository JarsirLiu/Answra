# Note：通用对话注入当前时间与时区

状态：已实施

## 问题

原 `apps/agent/src/conversation/turn/timeReminder.ts` 每轮把本机时间追加到最后一条用户消息，但不包含 IANA 时区和 UTC 时间。模型只能看到类似 `2026-11-10 14:32 (GMT+8)` 的短字符串，无法可靠判断用户所在时区、是否处于夏令时，也无法消除 `CST` 等缩写歧义。

原时间提醒只存在于本次模型请求中，没有写入 transcript，因此同一会话隔几小时或几天再聊时，下一轮会重新生成时间，不会把上一次的时间当成这一次。这个「每轮重算、不持久化」的性质必须保留。本次明确不计算「距上次对话几小时/几天」。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/conversation/turn/timeReminder.ts`：本地时间、IANA 时区、UTC offset、UTC 时间和相对日期说明。
  - `apps/agent/src/conversation/turn/modelMessages.ts`：把本轮时间上下文注入最后一条用户消息；注入位置不变。
  - `apps/agent/src/conversation/README.md`：补充时间提醒职责。
- 测试：
  - `apps/agent/test/conversation/turn/timeReminder.test.ts`（新增）
  - `apps/agent/test/conversation/application.test.ts`（对话集成断言更新）
- UI/进程/协议/持久化表面：
  - 不增加 IPC；不修改 transcript schema；不持久化时间提醒；不改变模型调用协议。
- 相关 Note：
  - `2026-11-07-conversation-workspace-system-context.md`
  - `2026-11-10-conversation-runtime-environment-context.md`

## 决定

### 时间内容

时间不放进 `# 运行环境` system block，也不写入 transcript。每次 `AgentDefinition.prepare` 生成独立的 `<system-reminder>`，追加到本轮最后一条用户消息：

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
- 不使用「上次对话是几小时前」这类会话间隔；本次明确不做。

### 时区来源

当前 Agent 是由 desktop 拉起的本机 utility process，与用户在同一台机器上，因此 v1 以 Agent 进程的本地时区作为用户时区：

- IANA 时区：`Intl.DateTimeFormat().resolvedOptions().timeZone`，缺失时回退 `UTC`。
- 本地日期时间：`Intl.DateTimeFormat` 按该 IANA 时区格式化。
- UTC 时间：`Date.toISOString()`。
- UTC offset：按当前时刻从 `Intl.DateTimeFormat` 的 `timeZoneName: "longOffset"` 取值，不使用固定 `+08:00` 常量。

不同时区用户使用各自系统时区；用户旅行或修改系统时区后，下一轮自动使用新时区。历史消息只是文本，没有可回写的旧时间提醒。

当前没有远程 Agent，因此不引入客户端时区通道。未来如果增加远程 sidecar 或由客户端提供时区，再单独提案：由 desktop 或客户端注入用户 IANA 时区，Agent 不得默认使用远端主机时区。

### 明确不做

- 不计算「距上次对话几小时/几天」，不给 `ConversationMessage` 增加时间戳。
- 不把当前时间写进 transcript 或 assistant 消息，避免下次对话读到旧时间。
- 不把当前时间放进静态 system prompt；静态内容会缓存、失真。
- 不使用事件 store 的最后事件时间代替用户本地时间。
- 不要求用户手动选择时区；桌面应用直接使用操作系统时区。
- 不在 Answer 和 Interview profile 注入时间；当前只有通用聊天显式开启 `injectTime`。

## 影响表面

- 通用对话每轮都会获得当前本地时间、IANA 时区和 UTC 时间；模型回答「今天几号」「现在几点」时有明确依据。
- 同一会话隔几小时或几天再发消息，时间提醒按新一轮时间重新生成；历史中的旧提醒不会被持久化。
- 不新增 transcript 字段，不改 UI，不影响现有消息展示。
- 时间提醒会把用户时区和当前时间发送给模型服务；不包含地理位置、IP 或用户身份。
- 不新增 IPC 频道；未来远程化时再定义客户端时区注入。

## 模块边界

- 时间文案属于 Conversation 模型上下文，放在 `conversation/turn/`。
- 时间来源是 Agent 进程的本地时钟与 `Intl`；不依赖 renderer、不新增 desktop 平台能力。
- 时间提醒只进入本次模型请求，不进入 transcript、事件 store 或持久化层。
- 若未来需要用户级时区覆盖或远程 sidecar，新增显式的 `TimeContext` 输入；不要让 conversation 直接读取远端主机时区。

## 曾考虑的替代方案

- **只保留当前 `currentDate` 短文案：** 舍弃。缺少 IANA 时区和 UTC，无法消除 `CST` 等歧义。
- **保留会话间隔：** 舍弃。用户明确本次不做「上次对话几小时前」；计算它需要给消息增加时间戳，扩大 shared schema 和测试面。
- **把当前时间写进 system prompt：** 舍弃。system 段更适合稳定事实；每轮时间变化会破坏缓存，并可能在长期会话里留下旧值。
- **把时间提醒写入 transcript：** 舍弃。下次对话会看到历史时间，模型可能把旧提醒当作现在。
- **用事件 store 的最后事件时间：** 舍弃。事件 store 记录 run 生命周期，不代表用户最后发言时间；还要新增跨层查询。
- **用 renderer 的 `Date` 或浏览器时区：** 舍弃。当前 Agent 与 desktop 同机，renderer 只增加 IPC 与信任面。
- **只给日期，不给时间或时区：** 舍弃。无法回答跨时区、跨天和当前时间问题。
- **固定 UTC：** 舍弃。用户看到的时间和系统时间不一致，跨时区体验错误。
- **要求用户设置时区：** 舍弃。操作系统已经提供，增加无必要的配置。
- **现在就让客户端传时区：** 暂缓。当前没有远程 Agent，Agent 本机时区就是用户 OS 时区；未来远程化时再设计注入协议，避免提前增加未使用的契约。

## 后果与防回退

- 时间提醒必须每轮重新生成并只追加到当前请求；不得写入 transcript 或复用上一轮 reminder。
- 相对日期必须以 `Current local time` 为基准；旧消息没有可靠时间戳，模型不得推断会话间隔。
- 时区与 offset 必须按当前时刻从 `Intl` 计算；跨夏令时和旅行不能使用固定 offset。
- 当前本机时区是 v1 的明确前提；远程 sidecar 或客户端时区注入属于后续独立决策。
- Answer 与 Interview profile 不开启 `injectTime`；新增 profile 时不要把时间写入静态提示词。

## 验证

- `timeReminder.test.ts`：上海本地时间与 IANA/offset、纽约夏令时冬夏 offset、UTC 格式、两次调用重新计算时间、明确不含会话间隔文案。
- `application.test.ts`：通用聊天请求包含 `<system-reminder>`、`# currentTime`、`Current local time:`、`Current UTC time:` 和禁止推断间隔的说明；Answer 请求不包含 `# currentTime`。
- 命令：`pnpm --filter @answra/agent exec vitest run test/conversation/turn/environmentContext.test.ts test/conversation/turn/timeReminder.test.ts test/core/tool/shell/runtime.test.ts test/conversation/application.test.ts`（49 项通过）。
- `pnpm --filter @answra/agent typecheck`、`pnpm lint` 通过。
- 全量 `pnpm --filter @answra/agent test` 中 395 项通过；6 个既有 shell 进程树/会话用例因 PowerShell 启动和 5 秒测试超时失败，另行跟踪，不属于本次时间上下文改动。
- 真实模型「今天几号」和跨天重开会话尚未人工验收；自动化只证明请求包含预期时间事实。
