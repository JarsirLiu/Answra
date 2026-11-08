# Note：可切换的内存与 SQLite 存储边界

状态：提案

## 问题

当前 Chat 与 Interview 在 `startAgentHost` 中共用同一组
`MemoryConversationStore`、`MemoryExecutionStore` 实例；Answer 使用独立的
answer-only worker host，因此有独立的进程内存实例。它们是不同领域用例，但不应
因此各自选择不同的持久化技术或数据库。未来切换 SQLite 时，所有 host 都应使用
同一种 SQLite adapter 和同一个应用数据库文件；每个进程可以有自己的连接与 adapter
对象，但按 `conversationId` 访问同一份数据。

现有两个 store 已通过接口注入，但宿主默认参数直接实例化内存实现，接口也没有把
revision、事务边界、并发写入和订阅语义写成可替换后端必须遵守的契约。若直接增加
SQLite 类，容易得到按领域各配一份数据库、或只在单进程路径上工作的适配器，无法
保证事件顺序、状态重建和 transcript 恢复与内存实现一致。

## 涉及范围

- 代码/模块：`apps/agent/src/execution/`、`apps/agent/src/core/transcript/`、`apps/agent/src/host.ts`、`apps/agent/src/answer/host.ts`
- UI/进程/协议/持久化表面：Agent 进程内存存储选择、事件恢复游标、transcript 恢复；不改变 IPC 事件名称和共享 schema
- 相关 Note：`2026-11-08-agent-session-and-object-status-model.md`

## 提案

采用“按数据职责拆 Store 端口、按应用统一选择后端”的策略。Conversation 与
Execution 仍是两个职责端口，但 Chat、Interview、Answer 不各自配置存储技术：
组合根选择一个存储 backend，由它创建 transcript 与 execution adapters。当前
backend 为内存；未来 SQLite backend 为两个端口提供共享数据库文件和一致的迁移、
连接管理。业务领域、UI 和事件 schema 不感知后端类型。

```text
Agent application storage configuration
  ├── ConversationStore adapter ─┐
  └── ExecutionStore adapter ────┴── backend / database
       ↑             ↑
     Chat          Interview       Answer
```

同一 Agent host 内的领域用例共享组合根创建的 adapter 实例。Answer-only worker
位于另一个进程，可以持有单独的 SQLite 连接和 adapter 实例，但使用同一个数据库文件、
schema 版本和事务规则。进程边界不等于数据分叉。

### 实施顺序

1. **先固定存储端口契约**
   - `ConversationStore` 负责 transcript、`activeRunId` 和 transcript 的
     `eventRevision`。
   - `ExecutionStore` 负责唯一 AgentEventEnvelope 事实流、Run 状态缓存、
     conversation aggregate revision 和事件读取。
   - 明确每个写操作的单 writer、revision 单调递增、重复 run/非法迁移失败、
     订阅只在 append 成功后通知。
   - 不新增 Session、Step、Tool、Part 快照接口或第二事件日志；Run 状态由
     ExecutionStore 更新，消息 Part 状态由 Transcript 消费同一个 envelope 更新。

2. **把后端选择移到统一 storage backend 组合入口**
   - 定义一个 backend/factory 负责创建配套的 `ConversationStore` 与
     `ExecutionStore`；两个 store 不能由各领域各自 new 或分别选择 driver。
   - `startAgentHost` 与 `startAnswerAgentHost` 接收 backend 创建的 store bundle，
     或由共同的 host factory 创建；默认 backend 返回内存实现。
   - Answer-only worker 使用相同的 backend 配置和数据库定位规则；SQLite 模式下
     它打开同一数据库文件，不另建 answer.sqlite 或按领域复制事件库。
   - 领域 application 只依赖 `ConversationStore`、`ExecutionStore` 接口，
     不 import `Memory*Store`。
   - 后端选择是应用启动配置，不通过 renderer、用户消息或任意 prompt 传入。

3. **补齐内存适配器的契约行为**
   - 为内存实现增加 revision 单调、afterRevision 边界、并发写入和订阅时序测试。
   - 明确 `clear`、`beginRun`、`finishRun` 的失败和幂等语义，使其成为 SQLite
     backend 必须保持的行为基线。
   - 不在本阶段增加 SQLite 依赖或磁盘文件。

4. **再实现 SQLite 适配器**
   - 同一个应用数据库保存 `AgentEventEnvelope` 事实和 transcript；可以按职责拆表，
     但不能按 Chat/Interview/Answer 拆成互不相干的数据库。
   - 表按 `conversationId` 等查询键区分会话数据，transcript 保存消息内容及恢复游标。
   - 运行状态和消息 Part 内容必须能从现有内存写入路径重建，不能成为第二事实来源。
   - SQLite adapters 由同一 backend 持有共享连接/事务执行能力；需要跨表一致性时，
     通过显式 transaction scope 一次提交，不能由 application 依次调用两个独立数据库
     实例自行拼接。

5. **最后切换与恢复验证**
   - 仅由统一 backend factory 把 memory adapters 替换成 SQLite adapters；Chat、
     Interview、Answer 的 application、IPC、UI 不分别改存储代码。
   - 验证切页恢复、`afterRevision` 增量读取、事件先到/快照后到、进程重启后的
     transcript 与执行状态重建，以及主 Agent host 和 Answer-only worker 对同一会话
     的读取一致性，再决定是否开启默认 SQLite。

### 持久化边界

当前阶段不持久化，退出 Agent 进程后内存数据丢失是明确行为。未来 SQLite 至少
需要保存：

- 全部领域共享的 `AgentEventEnvelope` 事实事件（不包含高频 delta，沿用现有
  durable 资格）；
- transcript message/part 的完整内容与 `eventRevision`；
- 必要的运行索引（conversation、run、attempt、sequence、aggregateRevision）。

数据库按应用/用户配置定位，不按 Chat、Interview、Answer 各建一份。是否长期保留
某类 transcript 仍由现有领域语义决定：例如 Answer 的一次性 transcript 清理行为
继续生效；共用 SQLite backend 不代表所有领域内容都必须无限期保留。

Run 当前状态由 ExecutionStore 内存缓存维护；Message/Part 状态随 Transcript 内容维护。
它们当前都不单独成为事实表。若将来为查询性能增加缓存，缓存必须带 revision，并允许
删除后重建。

## 模块边界

- `apps/agent/src/execution/store.ts`：执行事实与状态查询/写入端口，不知道 SQLite。
- `apps/agent/src/execution/memoryStore.ts`：当前进程内适配器。
- 未来 `apps/agent/src/execution/sqliteStore.ts`：SQLite 适配器，只实现端口，
  不把数据库 API 泄漏到 application。
- `apps/agent/src/core/transcript/store.ts`：transcript 端口。
- `apps/agent/src/core/transcript/memoryStore.ts`：当前 transcript 内存适配器。
- 未来 `apps/agent/src/core/transcript/sqliteStore.ts`：transcript SQLite 适配器。
- 未来 `apps/agent/src/storage/`：统一 backend/factory、SQLite 连接与事务生命周期；
  该模块按实际第二种 adapter 出现时建立，不预先扩出空目录。
- `apps/agent/src/host.ts`、`apps/agent/src/answer/host.ts`：消费同一 backend 配置；
  不各自决定 driver 或数据库路径。
- `packages/shared/src/schema/`：事件、状态和 snapshot 契约；不包含存储实现。

## 曾考虑的替代方案

- **现在直接引入 SQLite 并默认开启：** 舍弃。当前还没有跨进程重启恢复的验收证据，
  先引入数据库会把事务、迁移和文件生命周期问题混入领域修复。
- **只持久化当前状态，不保存事件：** 舍弃。状态无法审计和可靠重建，也会形成第二
  事实来源；事件 envelope 必须继续是执行事实。
- **Chat、Interview、Answer 各自建 Store 实例并各自选数据库：** 舍弃。领域用例
  不同不代表存储基础设施应分裂；拆分会造成同一 conversation 的 transcript、事件
  revision 和恢复记录彼此不可见。
- **所有内容合并成一个“大 Store”：** 舍弃。两个 Store 端口继续按数据职责区分；
  统一的是 backend、数据库文件、连接/事务管理和配置，不是把 transcript API 与事件
  API 混成一个接口。
- **让 application 依次写 transcript 和 execution 两个数据库：** 舍弃。跨表操作
  会产生半提交；需要一致性时应由同一 SQLite transaction 或明确的 outbox 协议承载。

## 验收标准

- 可观察结果：切换 memory/SQLite 只改变统一 backend 配置；Chat、Interview、Answer
  都通过同一存储策略访问会话数据。AgentEventEnvelope schema、IPC 和领域 application
  不因 driver 改变。
- 自动化验证：内存适配器覆盖 revision 单调、重复/非法写失败、并发认领、afterRevision
  和订阅时序；SQLite 适配器通过同一契约测试集。
- 需要的实机验证：首次启用 SQLite 时验证应用重启后 transcript、事件游标和可重建
  运行状态；验证数据库锁、迁移失败和磁盘不可写时显式失败。

## 风险

- 当前两个 store 不是同一事务；虽然 Chat/Interview 共用实例，transcript 与事件追加
  仍可能部分成功。SQLite 实施前要明确哪些业务操作需要跨表原子提交，并在 backend
  transaction scope 中实现，不能假定换成同一 SQLite 文件就自动原子。
- AI 流事件可能在进程退出时只完成部分写入；恢复协议必须区分已持久化事实和未完成
  Run，不能把活动状态恢复成正在生成。
- SQLite 文件位置、迁移版本、加密和清理策略尚未确定；这些属于后续持久化 Note，
  不在本提案中预设。
