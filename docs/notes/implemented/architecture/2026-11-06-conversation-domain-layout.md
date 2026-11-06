# Note：Conversation 领域目录按会话与回合组织

状态：已实施

## 问题

`apps/agent/src/conversation/generation/` 以实现手段命名，目录实际包含回复回合 runtime、请求内容校验和时间上下文；`runtime.ts` 超过 570 行，同时承担对外会话操作、回合认领、模型执行、凭据处理与终态收尾。`session/store.ts` 也把仓储端口、内存适配器和用户消息工厂放在同一文件。

目录名不能让维护者快速定位“会话事实由谁管理”或“一个回复回合如何执行”，文件规模也已超过仓库规范的审查阈值。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/` 与对应 Agent 测试目录、`apps/agent/src/index.ts`、worker 内部导入、根结构文档
- UI/进程/协议/持久化表面：不改变 worker/IPC 契约和运行行为；会话仍为 Agent 进程内存实现
- 相关 Note：[Agent 事件与状态的领域归属](../../implemented/architecture/2026-11-06-agent-event-status-domain-ownership.md)、[对话与答题 AI 领域拆分及对话能力复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)

## 决定

按领域事实和用例组织，而不是照搬 OpenCode/WeCode 的部署形态：

```text
conversation/
  README.md                 Conversation 领域地图与文件职责
  session/                  transcript、snapshot、revision 和仓储
    store.ts                会话仓储端口
    memoryStore.ts          当前进程内适配器
    message.ts              用户消息工厂
  turn/                     从用户输入认领到 assistant 终态的一次回合
    runtime.ts              会话操作与回合入口编排
    executeTurn.ts          AI SDK 调用与回合流程组合
    chatRuntime.ts          通用聊天 profile 的入口
    endpointFetch.ts        模型端点校验与云端/本地认证 fetch
    errorSummary.ts         模型错误的有界诊断投影
    modelMessages.ts        模型输入与历史上下文构造
    streamJournal.ts        模型事件写入 session 与回合诊断指标
    requestContent.ts       请求与图片边界校验
    timeReminder.ts         仅授权 profile 使用的时间上下文
  profiles/                 场景提示词、上下文策略与工具授权
  tools/                    Conversation 自有工具、工作区边界与静态注册
```

保留 `profiles/` 和 `tools/`，因为它们分别表达场景策略和 Conversation 拥有的能力，而不是传输或 UI 概念。`session/` 只拥有消息 transcript；run/attempt/step 执行事实仍属于独立 `execution/` 领域。跨领域共享原语仍由 `core/` 负责，但不得借本次目录整理新增跨领域抽象。

OpenCode 的 session 领域将 message、event、execution、prompt 和 runner 分成协作者；WeCode 将会话编排接到已有 session/task service 与协议。Answra 采用其职责拆分经验，不复制它们的 Effect/SQLite 服务体系、远程任务协议或大规模插件模型。

## 模块边界

- `session/store.ts` 声明 Conversation 仓储端口；`session/memoryStore.ts` 是唯一当前实现；`session/message.ts` 创建符合共享 schema 的用户消息。
- `turn/runtime.ts` 负责会话操作与一次回复的认领、取消、等待；`turn/executeTurn.ts` 执行已认领回合并以唯一 store 调用完成落账。
- AI SDK 的 `UIMessageChunk` 类型只出现在 `core/model/`；Conversation turn 消费共享的模型流事件。
- `profiles/` 只定义 Agent 拥有的提示词、历史策略和工具白名单；不接受 renderer 注入策略。
- `tools/` 只实现 Conversation 获准工具；不实现桌面平台能力。
- `conversation/README.md` 是领域目录导航，不是另一份类型或运行时契约。

## 曾考虑的替代方案

- **照搬 OpenCode 的完整 `session/{runner,event,execution,prompt}` 结构：** OpenCode 有持久化事件、SQLite 投影和更丰富的 agent loop；Answra 目前只有内存 transcript 与单进程回复，不应为尚未实现的恢复能力创建伪端口。
- **照搬 WeCode 的多包 session/task/provider 服务分层：** WeCode 面向多 host、协议和托管任务；Answra 当前是 desktop utility worker，拆成服务包会新增没有第二消费者的抽象。
- **保留 `generation/` 并只补 README：** 能解释目录，但不能解决 `runtime.ts` 多职责和 session 端口与适配器混放。

## 验收标准

- 可观察结果：Conversation 文件按 session、turn、profiles、tools 的职责可定位；`runtime.ts` 不再负责模型流执行细节；目录导航逐文件说明事实 owner。
- 自动化验证：Agent 测试、类型检查、架构检查、Note 检查和 `git diff --check` 通过。
- 需要的实机验证：无；协议、UI 与模型行为均不变。

## 风险

- 拆分运行编排可能改变取消、失败和清理顺序；必须完整复用现有行为测试，不能改写终态语义。
- 现有共享 schema 命名沿用历史 API；本次不做跨包 DTO 重命名。

## 后果与防回退

- Conversation 目录以 `session/`、`turn/`、`profiles/`、`tools/` 表达业务职责，新增文件必须在对应职责下，并在领域 README 登记。
- `session/store.ts` 是端口，不能重新混入内存适配器；当前唯一实现是 `session/memoryStore.ts`。
- `turn/runtime.ts` 负责认领与装配，模型流、错误与终态由 `turn/executeTurn.ts` 承担；不可把执行逻辑重新堆回组合根。
- 本次没有实现 durable execution、磁盘 transcript、远程会话服务或分布式 worker。

## 验证

- `pnpm --filter @answra/agent typecheck` 通过。
- Agent 测试 20 个文件、140 项通过。
- 完整 `pnpm verify` 通过：Biome、所有 workspace 类型检查和测试、架构检查均通过。
- `pnpm notes:check` 与 `git diff --check` 通过。
