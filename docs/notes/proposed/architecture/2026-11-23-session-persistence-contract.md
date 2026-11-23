# Note：会话持久化——两张表与追加式条目日志

状态：提案

## 问题

会话持久化是三代实现叠加出来的：先有 transcript 全量 JSON，再拆 `session_messages`，最后补 `session_events`、`session_turns`、`session_message_drafts` 和 `meta`。结果是 7 张物理表里有 3 张是派生数据或一次性标记，同一条 assistant 消息被事件、消息、草稿三处写入，却没有一页契约说清权威边界。

当前 7 张物理表（`schema.ts` 6 张 + 迁移账本）：

| 表 | 性质 |
| --- | --- |
| `sessions` | 会话头 + 上下文状态 |
| `session_messages` | 可变内容，流式期间反复 UPDATE |
| `session_events` | 只追加事实，但 `text-end` 不带正文 |
| `session_turns` | 事件的派生投影，无生产读路径 |
| `session_message_drafts` | 活动消息的整条副本 |
| `meta` | 旧 JSON 导入标记 |
| `_migrations` | 迁移账本 |

具体缺陷：

1. **正文不在权威存储里。** `text-end` / `reasoning-end` 只有 `partId`，完整文本只存在于 live delta 和草稿表。崩溃后事实日志解释不了消息里的半截正文。
2. **同一份内容写两处，却不对齐。** 事件与消息不在同一事务；「事件已写、投影未写」的窗口永远需要一条只在出事时执行的恢复路径来补。
3. **草稿写放大是 O(N²)。** 每 2048 字符或 1 秒重写整条 `message_json`；消息越大，累计写入越接近平方级。
4. **`state_json` 重复存正文。** 压缩检查点复制 `retainedUserMessages` 全文（含 base64 图片）；检查点越多，重复越多。
5. **派生表没有读者。** `session_turns` 只写不读；调度器启动时本来就从事件重新投影。它是第二份真相。
6. **`revision` 是半套并发控制。** 桌面与 CLI 各自使用独立数据库目录，同库没有第二个写者。

前三轮设计分别验证过三条路，结论是**都超过需求**：让事件当权威要付双写对账、重放等价和 upcaster；把日志做成文件要第二套存储、游标、压缩和坏行处理；只留消息表则无法表达「这一轮开始了但还没结束」。本提案把三者的优点压成一个形状：**条目级只追加 + 每行写入即终态**。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/`（schema、行读写、迁移；删除检查点调度）
  - `apps/agent/src/core/transcript/memoryStore.ts`、`store.ts`
  - `apps/agent/src/core/session/`（journal、`projection.ts`、`recovery.ts`、`transcriptBridge.ts` 收敛为条目端口与折叠）
  - `apps/agent/src/coding`、`conversation`、`interview`、`answer` 的 application 读路径
  - `packages/ui/src/app/conversationView.ts`（桌面与 CLI TUI 共用的折叠）、`useConversationView.ts`
  - `packages/shared/src/schema/session/frame.ts`、`schema/remote/frames.ts`、`channels/conversation.ts`
  - `packages/shared/src/schema/session/item.ts`、`fold.ts`（P0 已落地）与 `packages/shared/test/sessionItems.test.ts`
  - `packages/shared/src/schema/`（条目与 live 事件的词汇）
- 持久化表面：`sessions`、`session_items`（+ 迁移账本 `_migrations`）
- 相关 Note：
  - [SQLite transcript store](../../implemented/architecture/2026-11-17-sqlite-transcript-store.md)
  - [SQLite Session journal](../../implemented/architecture/2026-11-22-sqlite-session-journal.md)
  - [迁移 baseline 与账本](../../implemented/architecture/2026-11-18-sqlite-migration-baseline-and-ledger.md)
  - [持久化耐久性与冲突清理](../../implemented/bug-fix/2026-11-18-session-persistence-durability-and-conflict-cleanup.md)
  - [Step 边界排队](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md)
  - [压缩保留用户消息](../../implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [SessionFrame 线协议与四层命名](2026-11-22-session-frame-contract-and-naming.md)
  - [架构速查落点](../../implemented/process/2026-11-23-architecture-skill-layout.md)

## 提案

> 接手实现先读第 13 节（写入路径、端口、payload schema、折叠规则、迁移算法、测试清单）；第 1–12 节是决策与理由。
> 实现进度：P0（条目 schema + 折叠纯函数）、P1（`session_items` 建表与回填迁移）与 P2a（条目存储端口 + 内存/SQLite 实现）已落地；写路径、读通道与恢复尚未接线。

### 1. 两张业务表，两种生命周期

| 表 | 生命周期 | 权威 | 写入频率 |
| --- | --- | --- | --- |
| `sessions` | 可变，低频 | 会话身份、上下文状态、三个游标/计数列 | Turn 开始 / 结束、提交消息、压缩、改名 |
| `session_items` | **只追加** | 对话内容与过程本身 | 每个条目结算时写一次 |

`_migrations` 是 schema 基础设施（记录 checksum，防止历史迁移被改），不是业务表。

合并两表的依据是**生命周期一致**：会话行一天改几次，条目行写一次永不修改；两者都是「事实」，没有一条需要反复重写。被删掉的三类表各自缺失这一点：草稿表反复重写、`session_turns` 是派生、`meta` 是一次性标记。

`message_count` 留在 `sessions` 而不是删掉：桌面历史面板直接显示「N 条消息」，列表查询还用 `message_count > 0` 过滤空会话。它和 `next_seq` 在同一条 UPDATE 里维护，不增加写放大。

### 1.1 不变量

| 编号 | 不变量 | 违反后果 |
| --- | --- | --- |
| I1 | `session_items` 只追加，永不 UPDATE / DELETE（会话删除除外）；`item_id` 由领域 id 派生，`UNIQUE` 让重复追加成为 no-op | 顺序与断点续传游标失效；重试写入重复内容 |
| I2 | `seq` 由 `sessions.next_seq` 在同一事务内分配，只在实际插入成功后前进，不使用 `MAX(seq)+1` | 每次写都扫表；并发或崩溃后重号 |
| I3 | 每一行写入时即终态：存的是「这条记录的内容已完结」，不是「工具已执行完」 | 恢复需要判定中间态，退回两份真相 |
| I4 | delta 只走 live 通道，不落库；正文持久化只发生在条目结算时 | 写放大回到 O(N²) |
| I5 | 每个已开始的 Turn 恰好一行 `turn-end`；插入与清除 `sessions.open_turn_id` 同事务 | 崩溃后无法判定这一轮是否结束 |
| I6 | 进入模型请求的历史里，每个 `tool-call` 有且只有一个 `tool-result` 条目 | 下一次模型请求被 provider 拒绝 |

I3 是这套设计最值钱的一条：因为没有中间态，**「消息终态 ⇔ 所有 part 终态」这类不变量自动消失**，恢复也不需要判定「这一行写到哪了」。

I1 的 `item_id` 派生规则（不是随机 UUID）：

| 条目 | `item_id` |
| --- | --- |
| `user` | 用户消息 id |
| `text` / `reasoning` | 该 part 的 `partId` |
| `tool-call` | `toolCallId` |
| `tool-result` | `` `${toolCallId}:result` `` |
| `turn-end` | `` `${turnId}:end` `` |

这样同一段内容重试落库命中唯一约束即跳过，不需要额外的幂等账本。

### 2. 最终 DDL

```sql
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                    -- conversation | coding | interview | answer
  workspace_root TEXT,                    -- coding 域的工作区；其他域为 NULL
  title TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,    -- 下一条目要分配的 seq；同事务自增，空会话为 1
  message_count INTEGER NOT NULL DEFAULT 0, -- 列表展示与「空会话不列出」
  open_turn_id TEXT,                      -- 正在执行的 Turn；NULL 表示空闲
  state_json TEXT NOT NULL,               -- 上下文状态与种子，不存正文
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL                -- 列表排序；提交/开始/结束 Turn 时更新
);

CREATE INDEX sessions_scope_updated ON sessions(scope, updated_at DESC);
CREATE INDEX sessions_scope_workspace_updated
  ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC);

CREATE TABLE session_items (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),   -- 会话内严格递增；分页与续传游标
  item_id TEXT NOT NULL,                  -- 领域 id 派生，见 1.1
  turn_id TEXT,                           -- Turn 归属；无 Turn 的历史消息为 NULL
  message_id TEXT,                        -- 同一消息的多个 part 共享；turn-end 为 NULL
  kind TEXT NOT NULL
    CHECK (kind IN ('user','text','reasoning','tool-call','tool-result','turn-end')),
  status TEXT NOT NULL
    CHECK (status IN ('complete','interrupted','failed')),
  author_agent_id TEXT,                   -- assistant/tool 条目的作者 Bot；user 为 NULL
  audience_agent_id TEXT,                 -- 非 NULL = 只对该 Bot 可见（交接消息）
  payload_json TEXT NOT NULL,             -- 正文 / 工具输入 / 工具输出 / Turn 汇总
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, item_id),
  CHECK ((kind IN ('user','turn-end') AND message_id IS NULL)
      OR (kind NOT IN ('user','turn-end') AND message_id IS NOT NULL)),
  CHECK (kind <> 'turn-end' OR turn_id IS NOT NULL),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
```

不需要第二组索引：折叠、分页、恢复尾部扫描全部走 `(conversation_id, seq)` 主键；`item_id` 的唯一索引只服务幂等插入与工具配对查询。索引越少，追加越便宜。

`foreign_keys = ON` 已在 `sqliteDatabase.ts` 打开，级联删除可用，不再需要现存 schema 里那种手写 DELETE 触发器。

`kind` / `status` 用 `CHECK` 锁死：这张表不能 UPDATE，写一行错的就是永久错，只能在写入口拦。

### 2.1 `status` 到底表示什么

这是最容易写歪的一列，先定死：

| kind | 行什么时候写 | `status` 的含义 |
| --- | --- | --- |
| `user` | 提交时 | 恒为 `complete` |
| `text` | 这一步文本流结束 / 被打断 / 报错 | `complete` 完整；`interrupted` 生成中被打断；`failed` 这一步失败 |
| `reasoning` | 同上 | 同上 |
| `tool-call` | 模型这一步输出完、调用入参已确定 | `complete` 入参完整；`failed` 入参被截断或非法 |
| `tool-result` | 工具执行完 / 被拒绝 / 出错 | `complete` / `failed` |
| `turn-end` | Turn 结束 / 被取消 / 恢复收口 | `complete` / `interrupted` / `failed` |

**「工具还在跑」不是一种 `status`**，而是「有 `tool-call`、没有对应 `tool-result`」。UI 的 `running` / `interrupted` 由折叠推导：该 Turn 有 `turn-end` → `interrupted`，否则 `running`。存的是每行自己的终态，显示状态是推导值，两者不混。

同理，消息级 `role` 不存，由 `kind` 推出：`user` → `user`；`text` / `reasoning` / `tool-call` / `tool-result` → `assistant`；`turn-end` → 无消息。这样可以少一列，也不可能出现「`text` 行标成 user」这种自相矛盾。

### 3. 为什么是 2，不是 1 / 3 / 4

| 方案 | 为什么不选 |
| --- | --- |
| 1 张（全部塞进 `sessions`） | 每次结算重写整个会话行；消息无法分页 |
| 3 张（事件权威 + 消息投影） | 双写窗口、重放等价、upcaster 三笔长期成本，只为「可重放」，而产品不需要重放 |
| 3 张（文件日志 + SQLite 投影） | 第二套存储 + 游标 + 压缩 + 坏行跳过；买到的仍然是「可重放」 |
| 2 张（`sessions` + 消息级一行） | 结算单位是 part 不是 turn：工具结果要等整轮结束才能写，中途崩溃丢整轮 |
| **2 张（`sessions` + 条目级只追加）** | 成立 |

条目级不是「更细」，而是**唯一与结算时刻对齐的粒度**：

| 什么时候能确定 | 写成哪一行 |
| --- | --- |
| 用户发出 | 1 行 `user` |
| 这一步模型输出完 | 1 行 `text` + n 行 `tool-call` |
| 某个工具执行完 | 1 行 `tool-result` |
| 这一轮结束 | 1 行 `turn-end` |

按 message 写会把「这一步」和「整轮」混为一谈，于是任何一步都必须等整轮才能落库。

### 4. 一个两步 Turn 的完整数据

同一个 Turn 里 assistant 消息可以有**多条**：一次交接会给新 Bot 开一条新消息（`beginSessionAssistant`），而交接任务本身是一条 `audience_agent_id` 指向目标 Bot 的消息。每条消息各自带 `author_agent_id`，所以「谁说的、说给谁」不会丢。下面是最简单的单 Bot 两步 Turn，所有 assistant 条目同属 `m-a1`：

```text
seq kind        msg    status    author   audience payload
1   user        m-u1   complete  NULL     NULL     { text: "先看现有实现，然后加包装。", images: [] }
2   text        m-a1   complete  general  NULL     { text: "先看现有实现。" }
3   tool-call   m-a1   complete  general  NULL     { toolCallId: "call-01", toolName: "read",
                                                     input: { path: "src/x.ts" } }
4   tool-result m-a1   complete  general  NULL     { toolCallId: "call-01", outcome: "output",
                                                     output: { preview, truncated, totalBytes, path } }
5   text        m-a1   complete  general  NULL     { text: "已加包装，失败重试 3 次。" }
6   turn-end    NULL    complete  NULL     NULL     { finishReason: "stop", stepCount: 2, toolCalls: 1,
                                                     usage: { inputTokens, outputTokens },
                                                     durationMs: 8420, errorText: null,
                                                     interruption: null }
```

折叠结果就是当前的内存形状，`message_count = 2`、`next_seq = 7`：

```text
m-u1  user       text: "先看现有实现，然后加包装。"
m-a1  assistant  author: general
      text: "先看现有实现。已加包装，失败重试 3 次。"      ← text 条目按 seq 拼接
      parts: [ text(seq2), tool(seq3 提供入参, seq4 提供结果), text(seq5) ]
```

四个读法都只靠这张表：

| 问题 | 怎么做 |
| --- | --- |
| 打开会话的最后一页 | 按 `seq` 倒序取一页 |
| 一条完整消息 | 按 `message_id` 分组，`kind` 决定 part 形状，`seq` 决定顺序 |
| 喂模型的历史 | 折叠成 `ConversationMessage[]`，再走现有 `core/transcript/projection` |
| 这一轮结束了吗 | 有没有 `turn-end` |

`turn-end.payload` 承担原来 `session_operations` 表的所有列：状态、结束原因、耗时、步数、工具次数、用量、错误、中断原因。一个 Turn 只结算一次，正好是「写一次」的语义。

### 5. 写入时机

| 用户/系统做了什么 | 写什么 |
| --- | --- |
| 提交一条消息 | 同事务：分配 `seq`、`message_count += 1`、插 `user` 条目、更新 `updated_at`；**不置 `open_turn_id`** |
| Turn 开始执行（含排队轮到的） | 同事务：置 `open_turn_id`（条目在提交时已写入） |
| 模型流式输出 | **不写库**；只在内存累积，经 live 帧推给已订阅的客户端 |
| 文本 / 思考结算 | 插 `text` / `reasoning` 条目 |
| 工具入参确定 | 插 `tool-call` |
| 工具结束 | 插 `tool-result` |
| 用户点停止 | 同事务：未结算的 `tool-call` 各补 `tool-result{failed}` → 插 `turn-end{interrupted, cancelled}` → 清 `open_turn_id` |
| 取消排队中的 Turn | 插 `turn-end{interrupted, cancelled}`（此刻没有 `open_turn_id` 可清） |
| 进程崩溃 | 无写入 |
| 恢复（打开/提交/连接时惰性触发） | 见第 7 节 |
| 压缩完成 | 只 UPDATE `sessions.state_json`；不产生条目 |
| 删除会话 | 删 `sessions` 一行，级联 |

`message_count` 只在「这个 `message_id` 首次出现」时 +1：每条 `user` 消息一次；assistant 消息在它第一个 part 结算时一次。内存工作集里已经有消息列表，判断不需要额外查询。

`open_turn_id` 只在 Turn 真正开始执行时置位：提交后、开始前崩溃必须留下「有 user 条目、无 `turn-end`、无 `open_turn_id`」的 pending 状态，恢复时重新入队；若提交就置指针，恢复会把它误收口成 `process-exit`，用户消息永远不再被回答。

`turn_id` 在提交时就确定：一条用户消息就是一次 Turn 提交。当前 `appendUserMessage(conversationId, text)` 不接收 turn id，切到条目后要改成由写入方生成并返回，否则「先落用户消息、后开 Turn」的旧数据没有归属。

`sessions.updated_at` 在提交、Turn 开始、Turn 结束三处更新；流式期间的「新鲜度」不是持久化概念。

### 6. 流式：写在结算，读在内存

- **写**：流式期间不落库。一步的文本/工具调用在**这一步结算时**一次写成条目。
- **读**：已结算的条目从库里读，当前正在生成的那一截从内存拿。
- **订阅**：客户端从「最后一个已结算 seq」续传；**协议必须让新订阅者拿到当前未结算那一截的初始快照**，否则中途打开会话的人会看到空白，直到这一步结束才突然出现整段。

这条内存态不是第二份真相：它随时可以丢，丢了只影响正在跑的这一截，不影响任何已结算的行。因此它不构成「两个投影必须永远一致」的负担。

### 7. 崩溃与中断

| 场景 | 结果 |
| --- | --- |
| 用户点停止 | **不丢**。已生成的部分落成 `text{interrupted}`，未结算工具补失败结果，`turn-end{interrupted}` 同事务 |
| 进程崩溃 | **丢尾巴**。最后一步未结算的内容在内存里，随之消失；已结算的条目全部保留 |
| 断电 | 同上 |

「取消不丢、崩溃丢尾巴」是本提案明确接受的一条契约。用户能分清这两件事：点了停止却缺半截是不可接受的，程序崩了丢最后半句可以接受。若将来要求崩溃也保尾，唯一的补法是加一个反复 UPDATE 的草稿行，I3 随之失效，本设计的收益也就没了。

`turn-end` 的 `status` 只用 `complete | failed | interrupted`；取消与崩溃都记 `interrupted`，具体原因在 `payload.interruption.reason`（`cancelled` / `process-exit` / `migrated`）。这样状态词汇与 `text` 条目保持一致，不额外发明 Turn 专用的第三套词。

**折叠必须容忍缺失的 `turn-end`**：`open_turn_id` 指向的 Turn 按 `running`，其余按 `interrupted`。打开会话时恢复会先收口，所以 `running` 只出现在收口之前那一瞬。这条让「启动时全库扫描收口」变成可选项，而不是正确性前提。

恢复按会话惰性触发（打开、提交、连接时）：

```text
1. 折叠本会话最后一段条目，找出没有 turn-end 的 Turn：
   若 sessions.open_turn_id 指向它
     → 未结算的 tool-call 各补一条 tool-result{failed, interrupted}
     → 插 turn-end{interrupted, process-exit} → 同事务清 open_turn_id
   否则（排队中的 Turn）
     → 只有 user 条目：重新入队（没发出过模型请求，无副作用）
     → 已有 assistant/tool 条目：同上补 tool-result 与 turn-end（不续跑）
2. 所有补写走 UNIQUE(item_id)，重复执行是 no-op
```

第 1 步里的「补 `tool-result`」不是补回真实结果，而是**给这次调用一个合法终态**（失败 + 中断原因）。不补的话，assistant 消息里会留下悬挂的 `tool-call`，下一次模型请求会被 provider 拒绝（I6）。

第二类不自动续跑，因为工具副作用不幂等；第一类可以安全续跑，因为它连一次模型请求都没发出。

### 8. 压缩、fork 与删除

- **压缩**：`state_json.contextState.checkpoints[]` 继续用 `throughMessageId`——压缩边界永远落在整条消息之间，消息 id 在条目模型里依然稳定，`messagesAfterCheckpoint` 不用改。只把 `retainedUserMessages`（整条消息副本）换成 `retainedMessageIds`，正文从条目读，避免检查点重复存正文与 base64。
- **fork**：**当前代码里没有这个功能**（全库搜不到 fork 实现），所以不加 `parent_session_id` / `fork_session_id` / `fork_boundary_seq`。真做的时候：复制 `seq <= boundary` 的条目到新会话（seq 原样保留、`next_seq` 接着数），在 `sessions` 上加边界列。现在加等于留三个永远为 NULL 的列。
- **删除**：只删 `sessions` 行，条目走外键级联。
- **两处易踩的重复**：`state_json.snapshot` 与 `contextState` 的 compaction/usage/pruning 只保留一份（以 `contextState` 为准，snapshot 字段派生）；`snapshot.conversationId` 与顶层 `conversationId` 不重复存。

### 9. 内容预算

条目是「一次写、永不改」，所以更要在写入前把体积压住：

| 内容 | 规则 |
| --- | --- |
| 工具输出 | 写库前截断，条目里存截断结果 + `truncated` / `totalBytes` / 全文路径 |
| 压缩摘要 | 只存 `state_json` 一份，条目里不再复制 |
| delta | 不落库 |

**图片暂时保持现状**：`ConversationMessage.images` 现在是 `{ name, dataUrl }`，即 base64 内联。把它换成 `{ fileId, mime, bytes, sha256 }` 要同时改 `packages/shared` 的 schema、`packages/ui` 的渲染和 desktop 的读图路径，属于独立变更；在那之前条目沿用现有形状，只对工具输出做截断。不假装这一项已经解决。

### 10. 迁移步骤

| 步骤 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 | 定义条目种类、`payload` schema 与折叠函数（纯函数，无 IO） | **已落地**：`packages/shared/src/schema/session/{item,fold}.ts` + `test/sessionItems.test.ts`；折叠单测覆盖 13.8 前六条 |
| P1 | 新增 append-only 迁移：建 `session_items`，按 13.6 展开 `session_messages`；`streaming` 一律转 `interrupted` 并补 `turn-end` | `pnpm db:check` 通过；迁移后折叠结果与原消息等价 |
| P2 | 写入面切到条目端口（`SessionItemStore`）；SQLite 适配器写条目而不是 message 行；删 journal / `projectSession` / 双通道 | 桌面与 CLI 读同一折叠；`session_items` 无 UPDATE |
| P3 | 恢复改为 `open_turn_id` + 尾部扫描；删 `recovery.ts` 的事件重放 | 崩溃模拟三类场景通过 |
| P4 | 删 `session_events`、`session_messages`、`session_turns`、`session_message_drafts`、`meta`、`revision` | 库里只剩 2 张业务表 |
| P5 | durable 通道改为「按 seq 读条目」；会话级状态改走 snapshot + live status frame；同步 remote/mobile 帧 | 桌面、CLI TUI、远程/移动端共用同一条折叠 |
| P6 | 同步 `AGENTS.md`、`.agents/skills/answra-arch/`、本 Note 的 `SessionFrame` 关联文档 | 文档与代码一致 |

P1 与 P2 必须同批交付，否则会出现「读旧表、写新表」的空窗。新增迁移走现有 `migration/registry.gen.ts` 的 append-only 账本，用 `pnpm db:generate` 重建 `schema.snapshot.json`，不手改快照。迁移只前进；回退需要 `pnpm db:reset`。

具体展开算法、端口形状、`payload` schema、折叠规则与测试清单见第 13 节，不在这里重复。

### 11. 外部实现对照与长期边界

#### 11.1 三家怎么存

| | Codex | OpenCode v2 | LobeHub | 本提案 |
| --- | --- | --- | --- | --- |
| 消息落哪 | JSONL 文件（每会话一个） | SQLite 投影表 | Postgres 表 | `session_items` |
| 条目粒度 | 一行一个 item | 一行一个 message / part | 一行一条 message | 一行一个 part |
| 事件/step 落库 | 落（文件里） | 默认否（`persist` 缺省 false） | **不落** | 不落 |
| 运行状态 | 派生投影 | `session_v2` 列 | `agent_operations` 行 | `turn-end` 条目 + `open_turn_id` |
| step 明细 | 文件行 | 内存 | **一次运行一个 JSON，存对象存储** | 不存（需要时存快照文件） |
| 崩溃入口 | 日志 + 投影游标 | claim + `resume_attempts` | 扫 running 行 | `open_turn_id` + 尾部扫描 |
| delta | 不落 | 不落 | 不落 | 不落 |

三家都遵守同一条事实：**没有一家把「每个 step 一行」放进业务库**，而 delta 一律不落。差别只在「明细放文件、放对象存储，还是干脆不留」。

#### 11.2 后台工具与排队怎么落在条目上

后台工具的真实形态是**句柄结算**，不是「Turn 结束但调用还挂着」。模型协议要求 assistant 消息里的每个 `tool_use` 都有 `tool_result`，所以工具在 Step 内必须给出终态：

| 触发 | 条目怎么落 |
| --- | --- |
| 模型带 `background: true` | `tool-result{complete, output:{backgrounded:true, jobId}}`，Turn 正常结束 |
| 前台调用超时转后台 | 同上，结果里带超时说明 |
| 进程在调用中途被杀 | 恢复时补 `tool-result{failed, interrupted}`；不补就违反 I6 |
| 后台任务完成 | 开新 Turn，首条目为将来的 `kind: job`（synthetic 输入，靠 `kind` 与真实用户消息区分）；不改表结构 |

排队同理：pending = 有 `turn_id`、有 `user` 条目且没有 `turn-end`，不需要 inbox 表。steer 的成本不在存储，而在 Turn 语义——它要求同一 Turn 在 Step 边界接受多次输入，需要新增条目种类并让模型上下文按 Step 重算，这是执行模型的改动。

#### 11.3 什么时候才该加表

| 需求 | 加什么 | 不加什么 |
| --- | --- | --- |
| 要能回答「每一步喂了什么给模型」 | 单次运行一个 trace JSON（临时文件或对象存储），`turn-end` 记路径 | 不加事件表，不写 JSONL |
| 单条条目 p95 超过 256 KiB | 正文分片表（`session_item_parts`） | 不回退到草稿行 |
| 要跨会话列出/取消后台任务 | `session_jobs` 读模型（可重建） | 不把 Job 状态塞回 `state_json` |
| 同一会话出现多个并发写者 | 带 fencing 的写者声明列 | 不加业务表 |
| **事实日志本身要长期保留、可裁剪、可跨系统同步** | 才轮到「日志即权威 + 投影游标」 | 在此之前都不该引入 |

最后一行是唯一能让结论整体翻转的条件。只要条目本身就是唯一一份内容且长期保留，就不存在「待投递义务被清理」的问题，也就不需要 obligation 表。

### 12. 客户端怎么读：桌面、CLI TUI、远程与移动端

#### 12.1 三样东西

现在的客户端靠两样东西拼出界面：`ConversationSnapshot`（初始化与修复）+ `SessionFrame`（durable 续传）。两表方案不改这个结构，只换掉第二样的单位：

| 通道 | 内容 | 丢失后果 |
| --- | --- | --- |
| `ConversationSnapshot` | 折叠 `seq <= lastSeq` 的条目 + 内存里正在生成的那一截 | 权威来源，没有「丢失」 |
| `SessionItemFrame { sessionId, item }` | 一条已结算的条目；`seq` 在 `item` 里 | 缺口由「按 seq 重读」补齐 |
| `SessionStatusFrame { sessionId, status }` | 活动 Turn / 活动消息 / 用量 / 压缩 / 清理 / 队列长度 | 只影响瞬时观感，下一次 snapshot 覆盖 |

`SessionStatusFrame` 是新增的：这些量原本搭着 durable 事件（`turn-started`、`context-usage-changed`、`compaction-*`）走，现在没有事件表了，必须给它们一条显式的可丢通道。它们本来就只是会话级状态，不是内容。

`RemoteSessionFrame` 只是 `SessionFrame` 的透传包装，P5 跟着一起换；移动端和 CLI `remote host` 不需要第二套逻辑。

#### 12.2 折叠必须按 `item_id` 覆盖，不能盲目追加

这是最容易踩的坑。`snapshot` 里包含**内存中正在生成**的那一截（和今天的草稿等价），而这一截随后会以条目形式再投递一次。如果客户端按「追加」处理，同一段文本会出现两遍。

规则：**客户端把条目 upsert 进消息，键是 `item_id`**。`item_id` 就是 `partId` / `toolCallId` / 消息 id，所以内存里那一截和后来的条目天然同键，覆盖即幂等。

由此得到两条推论：

- `snapshot.lastSeq` 只覆盖已结算条目；正在生成的部分不算进度，不会推进游标。
- 同一 part 的条目只可能有一条（`UNIQUE(conversation_id, item_id)`），所以「覆盖」和「追加」在正确性上等价，覆盖只是为了让 snapshot 与重放叠加时不出重影。

#### 12.3 能力矩阵

| 能力 | 依赖 | 两表下 |
| --- | --- | --- |
| 桌面发送 / 停止 / 排队 / 队列位置 | snapshot + 帧 + host 队列 | ✅ 队列仍在 host 内存，条目只记录已结算内容 |
| 桌面历史列表（标题 / 条数 / 删除） | `sessions` + `message_count` | ✅ 过滤空会话仍用 `message_count > 0` |
| 恢复历史会话 | snapshot + 草稿合并 | ✅ 折叠条目；草稿合并整条删除 |
| 手动 / 自动压缩与边界展示 | 检查点 + 压缩状态 | ✅ `state_json` 存，边界随 snapshot 下发（`throughMessageId` 不变） |
| 上下文用量与清理提示 | `context-usage-changed` / pruning | ✅ 落在 `state_json` + status frame |
| 多 Bot 与会话内交接 | `turn-handoff` + author/audience | ✅ `author_agent_id` + `audience_agent_id` |
| 截图答题 | answer 域内存 | ✅ 不受影响（不读盘不落盘） |
| 面试演练（文本 + 语音转写） | 先落 user 消息、后开 Turn | ✅ `turn_id` 可空；转写先成为无 Turn 的 `user` 条目 |
| 面试资料整理 intake | transcript + `profile.xml` | ✅ 与普通会话同构 |
| CLI TUI 会话恢复 / 切换 | snapshot + `readFrames` | ✅ 按 seq 续读条目 |
| CLI 工具折叠与详情 | `parts` | ✅ 条目按 seq 拼回 part 顺序 |
| CLI 压缩边界 / 清理提示 | snapshot | ✅ |
| CLI 排队提示 | `runController` 本地队列 | ✅ |
| 远程 host（PC / 手机 controller） | `SessionFrame` 透传 | ⚠️ P5 同步改帧类型 |
| 移动端会话 | 同上 | ⚠️ P5 |
| 崩溃后「这一轮怎么了」 | 无 | ✅ `turn-end{interrupted, process-exit}`；收口前按 `running` 显示，收口在打开会话时发生 |

#### 12.4 原来那条 durable 事件流里，哪些东西不再落库

事件表被删掉后，不是每一项都能变成条目。逐条交代：

| 原 durable 事件 | 去向 |
| --- | --- |
| `turn-queued` / `turn-started` / `turn-finished` | `user` 条目 + `open_turn_id` + `turn-end` |
| `turn-handoff` | 交接消息本身是一条 `text` 条目（`audience_agent_id` 指向目标 Bot） |
| `step-started` / `step-finished` | 不落库；用量与错误汇总进 `turn-end`，用量锚点进 `state_json` |
| `compaction-*` | 不落库；压缩状态与检查点在 `state_json` |
| `context-usage-changed` | 不落库；`state_json.contextState.usage` + status frame |
| `part-state-changed` | 条目的 `status` |
| `text-*` / `reasoning-*` / `tool-call` / `tool-result` / `tool-error` / `tool-output-denied` / `tool-execution-*` | `text` / `reasoning` / `tool-call` / `tool-result` 条目 |
| `start` / `finish` / `abort` | 吸收进 `turn-end` 的 `finishReason` 与 `usage` |
| `retry` | 转 live-only；重启后一条已死的重试提示没有意义 |
| `model-warning-*` | 转 live-only；`ConversationMessagePart` 没有 warning 形状，本来就没有渲染消费者 |
| `source-url` / `source-document` / `file` | 转 live-only；part 词汇只有 text / reasoning / tool，现在也没显示（`file` 的 base64 更不该进库） |
| `tool-approval-request` | 转 live-only；全库没有审批回执通道，`awaiting-approval` 目前是死状态。真做审批时加 `kind: tool-approval` |

一句话：**条目只有「用户看得到的对话内容」，其余都是可丢的运行状态。**

#### 12.5 一条行为变化要认下来

今天的 `turn-queued` 会持久化，所以「面试回复排队中崩溃 → 重启后继续回」是成立的。两表下，一个**没有任何内容**的排队 Turn（`source: reply` / `opening`，没有 user 消息）不会留下行，重启后不会自动续跑。

- 有 user 消息的排队 Turn：仍然恢复（`turn_id` + 无 `turn-end`）。
- 没有 user 消息的排队 Turn：丢弃。它没有可重放的输入，用户看到的是「最后一条消息还没回复」，再发一条即可。

如果将来要求这类 Turn 也恢复，加一个 `kind: turn-start` 条目即可（代价是每个 Turn 多一行，且重新引入「成对出现」的约束）。现在不加。

### 13. 实现契约（接手时照这一节写）

#### 13.1 写入路径：谁在什么时候调什么

今天 durable 事件从 `StepExecutor` 的 `JournalStepEventSink` 唯一漏斗进 journal，再经 `SessionTranscriptBridge` 投影成消息。新模型保留这个漏斗，只把「append 事件」换成「append 条目」，**不需要新的 settle 判定层**：

| 事件（现在写 journal） | 条目（现在写 items） |
| --- | --- |
| `text-end` | `text{ itemId: partId, text: 内存里该 part 的全文 }` |
| `reasoning-end` | `reasoning{ itemId: partId }` |
| `tool-call` | `tool-call{ itemId: toolCallId }` |
| `tool-execution-finished` / `tool-result` | `tool-result{ itemId: toolCallId + ":result" }` |
| `tool-error` | `tool-result{ failed, outcome: "error" }` |
| `tool-output-denied` | `tool-result{ failed, outcome: "denied" }` |
| `turn-finished` | `turn-end{ itemId: turnId + ":end" }` + 清 `open_turn_id`（同事务） |

`tool-execution-finished` 与 `tool-result` 会各来一次，落成同一个 `item_id`，第二条命中唯一约束即 no-op——这正是派生 `item_id` 的意义，不需要去重逻辑。

**用户消息在提交时写，不在 Turn 开始时写。** 今天 `turn-queued` 只把 input 记在内存和 journal 里，turn 真正开始才落消息；两表下改成提交即写 `user` 条目，排队中的消息因此能在崩溃后存活，也才有「有 `turn_id`、无 `turn-end` = pending」这条判据。代价是 `appendUserMessage` 要在提交路径上被调用（conversation / interview 已经这么做了）。

**顺序要求：先更新内存视图，再写条目。** `text-end` / `reasoning-end` 的正文不在事件里，要从内存里那个 part 读。所以漏斗必须是「应用到内存 → 若是结算事件则 append 条目 → 广播 item frame」，反过来会写出空文本。

#### 13.2 端口（替代 `ConversationStore` 的写入面）

读面（`load` / `list` / `getSession` / `delete`）保持现有形状；只换写入面：

```ts
export interface SessionItemDraft {
  itemId: string;                       // 见 1.1 的派生规则
  status: "complete" | "interrupted" | "failed";
  turnId?: string;                      // 面试转写先落无 Turn 的 user 条目
  messageId?: string;                   // turn-end 与 user 省略
  authorAgentId?: string;               // assistant/tool 行
  audienceAgentId?: string;             // 交接消息
  payload: SessionItemPayload;          // 见 13.3，kind 在 payload 里
}

export interface SessionItemStore {
  create(conversationId: string, seed?: ConversationSessionSeed, metadata?: ConversationSessionMetadata): Promise<ConversationSnapshot>;
  load(conversationId: string): Promise<ConversationSnapshot>;   // 折叠 + 内存半截
  appendUserMessage(conversationId: string, message: ConversationMessage, turnId: string): Promise<void>;
  appendItems(conversationId: string, items: readonly SessionItemDraft[]): Promise<void>; // 同事务分配 seq
  beginTurn(conversationId: string, turnId: string): Promise<void>;   // 置 open_turn_id
  finishTurn(conversationId: string, turnEnd: SessionItemDraft): Promise<void>; // 插 turn-end + 清指针
  loadContextState / saveContextState / clear / close                  // 形状不变
}
```

现有的 `beginSessionTurn` / `beginSessionAssistant` / `applySessionStreamEvent` / `finishSessionAssistant` 在内存侧语义不变（内存快照仍是 live 视图的唯一来源），只是 SQLite 适配器的写穿目标从「整条 message 行」变成「结算条目」。

#### 13.3 `payload_json` 的 schema（已落地：`packages/shared/src/schema/session/item.ts`）

每个 kind 一个 strict schema，由 `packages/shared` 导出，写入前 `parse`、读出时 `parse`，不存多余字段。`kind` 只在 `payload` 里出现一次；SQLite 适配器用它填 `kind` 列，读出时校验两处一致。

```ts
type SessionItemPayload =
  | { kind: "user";        text: string; images: ConversationMessage["images"] }
  | { kind: "text";        text: string }
  | { kind: "reasoning";   text: string }
  | { kind: "tool-call";   toolCallId: string; toolName: string; title?: string; input?: unknown; inputText?: string }
  | { kind: "tool-result"; toolCallId: string; outcome: "output" | "error" | "denied";
                           output?: unknown; errorText?: string; durationMs?: number }
  | { kind: "turn-end";    finishReason?: AgentFinishReason; reason?: TurnFinishReason;
                           stepCount: number; toolCalls: number;
                           usage?: AgentUsage; durationMs?: number; errorText?: string;
                           interruption?: { reason: "cancelled" | "process-exit" | "migrated"; at: string } };
```

行上的字段（`SessionItem`）是 `seq` / `itemId` / `status` / `createdAt` / `turnId?` / `messageId?` / `authorAgentId?` / `audienceAgentId?` + `payload`。`seq` 属于条目本身（帧不再重复携带），`SessionItemDraft` 是同一形状去掉 `seq` 与 `createdAt`。

schema 层面已锁死四条组合约束：`turn-end` 必须有 `turnId` 且不携带 `messageId`；`user` 不携带 `messageId`、无作者且状态恒为 `complete`；其余 kind 必须有 `messageId`；`interrupted` 的 `turn-end` 必须说明中断原因。`tool-call` 与 `tool-result` 的行状态恒为 `complete`——工具的执行结果与成败由 `tool-result.outcome` 表达，「这条调用没跑完」由折叠按 Turn 相位派生，不写成第二条事实。

`tool-call` 的 `input` 与 `tool-result` 的 `output` 在写入前过第 9 节的截断。

#### 13.4 折叠规则（已落地：`packages/shared/src/schema/session/fold.ts`）

输入 `SessionItem[]` 与会话行的 `open_turn_id`，输出 `ConversationMessage[]`。**不直接产出模型消息**——`ConversationMessage[]` 之后照旧走 `core/transcript/projection.ts` 与 `conversation/turn/modelMessages.ts`，不再维护第二条模型投影。

放在 `packages/shared` 而不是 `core/session`：agent（快照装载、迁移比对）与 ui（桌面与 CLI TUI 的客户端折叠）都要用，而两者不能互相 import。它和 `toSessionFrame` 同性质——两个共享契约之间的纯投影，不带 IO、不带领域策略。

1. 条目按 `seq` 排序（输入无序也成立）；消息按首次出现的 `seq` 排列，part 按各自 `seq` 排列。
2. `user` 行 → `{ id: itemId, role: "user", text, images, status: "complete", parts: [], audience: { kind: "user" } }`。
3. assistant 组：
   - `text` / `reasoning` 行折成同名 part（`status: complete → completed`），`message.text` 与 `message.reasoning` 都是 part 的无分隔拼接——`memoryStore` 是逐 delta 累加，两者必须逐字节一致，不能用 `"\n\n"`；
   - `tool-call` 行折成 `tool` part 并记住位置，`tool-result` 行（同 `toolCallId`）原地补 `state` / `output` / `errorText`，不新增 part；缺少对应 call 的 result 直接抛错（fail-closed，不静默丢）；
   - `authorAgentId` 取组内首个非空值；`audience_agent_id` 非空映射为 `{ kind: "bot" }`，否则写 `{ kind: "user" }`（与 `createAssistantMessage` 的现有形状一致）；
   - 用户可见但没有 `messageId` 的条目（不可能出现）与空 Turn 不产出消息。
4. 每个 Turn 先算一个相位：有 `turn-end` → 取它的 `status`；没有且 `turn_id === open_turn_id` → `open`；其余 → `interrupted`；条目没有 `turn_id`（迁移来的历史消息）→ `unattributed`。
5. 状态派生只看两件事：
   - **只有该 Turn 的最后一条 assistant 消息承载 Turn 终态**（`open → streaming`，其余直接取相位）；这条来自运行时唯一 writer：一个 Turn 同时只有一条活动消息，交接消息在写交接事件时已经是 `complete`；
   - 其余消息只看自己的 part：有 `failed` → `failed`，有 `interrupted` → `interrupted`，否则 `complete`。`unattributed` 的消息也走这条。
6. `tool` part 没有 result 时按相位补终态：`open → running`，`failed → failed`，其余 `interrupted`。

`open` 只出现在收口之前那一瞬，也只影响 live 视图；落库的每一行仍然是各自终态。`open_turn_id` 指向的 Turn 若已经有 `turn-end`，以 `turn-end` 为准——指针不能复活一个已结束的 Turn。

#### 13.5 `state_json` 只剩三样

```jsonc
{
  "schemaVersion": 1,
  "seed": { "activeAgentId": "...", "participantAgentIds": ["..."], "bots": [{ "id": "", "name": "", "role": "" }] },
  "contextState": { "checkpoints": [], "compaction": {}, "usageAnchor": {}, "usage": {}, "pruning": {},
                    "prunedToolCallIds": [], "compactionFailureCount": 0, "compactionRetryAt": "" }
}
```

`snapshot` 那一层删掉：`conversationId` 用列、`lastSeq` 从 `next_seq - 1` 算、`messages` 从条目折、`contextCompaction` / `contextUsage` / `contextPruning` / `contextCompactionBoundaries` 全部从 `contextState` 派生（`memoryStore.ts` 的 `snapshotOf` 已经是这个做法，照搬）。

#### 13.6 迁移算法（P1）

```text
1. 建 session_items（含 CHECK 与唯一约束），并给 sessions 加 next_seq / open_turn_id。
2. 先合并草稿：只有 base_revision === sessions.revision 的 draft_json 覆盖消息正文，
   与 mergeStoredSession 同义；忽略其余草稿。崩溃残留下的半句是那半句的唯一副本。
3. 按 session_messages.seq 升序分组成 Turn：
   一条 user 消息开启新 Turn；其后的 assistant 消息同属该 Turn；
   首条 user 之前的 assistant 消息属于开场 Turn。
   turn_id 优先取行上的 turn_id；为空时用户 Turn 用 user 消息 id，开场 Turn 用 opening:<首条消息 id>。
4. 对每条消息生成条目（同一 Turn 内按消息 seq、part 顺序分配 seq）：
   若 message_json.parts 非空：
     逐 part 生成条目：
       text / reasoning → 同名条目，itemId = part.id；
         status 取 part.state 映射（completed→complete，failed→failed，其余→interrupted）
       tool → 一条 tool-call（itemId = part.id，status 恒为 complete）；
         part.state 为 completed / failed / denied 时再补
         tool-result（itemId = toolCallId + ":result"，outcome 分别为 output / error / denied）；
         其余状态不补 result，由 Turn 相位折成 interrupted
   否则若 message_json.text / reasoning 非空：
     生成 text（itemId = 消息 id + ":text"）与/或 reasoning（itemId = 消息 id + ":reasoning"）
   两者都空的消息（崩溃前的占位）跳过：不占 seq、不计数
   user 条目 itemId = 消息 id，status 恒为 complete；part 条目携带 messageId。
5. 每个 Turn 组末尾补一条 turn-end（itemId = turnId + ":end"）：
   status 取该 Turn 最后一条 assistant 消息的状态（complete / failed / 其余→interrupted）；
   没有 assistant 消息的 Turn 一律 interrupted；
   interrupted 的 interruption.reason：原消息 streaming → "process-exit"，否则 "migrated"；
   payload.stepCount = 0，toolCalls = 该 Turn 的 tool-call 条目数。
6. 回写 sessions.next_seq（= 最后分配的 seq + 1）与 message_count（= 真正产出了条目的消息数）；
   updated_at 不因迁移而变。
7. 旧表 session_events / session_turns / session_message_drafts / meta / session_messages
   在 P4 删除；P1 保留，便于回退与比对。
```

迁移只搬运「用户看得到的内容」：`session_events` 里的 delta、warning、source、file 一律丢弃（见 12.4）。迁移后 `load` 的折叠结果必须与迁移前 `restoreConversationSnapshot` 一致：消息身份、角色、正文、作者/接收方、消息状态与 part 状态相同。前两处形状归一是折叠的定义而非数据丢失，P1 测试逐条断言；第三处是 Turn 相位派生的必然结果，写入前已知：

- 折叠总会物化 `audience`（旧消息缺省时写 `{ kind: "user" }`）；
- 没有 parts 的 assistant 正文（交接消息、早期记录）会物化成一条 text part；
- failed Turn 里未结算的 tool part 按 Turn 相位折成 `failed`，旧恢复统一折成 `interrupted`。

`message_count` 不把空白占位算作消息；这些占位迁移后不再产出消息，与第 7 节「空白 Turn 不恢复」一致。

迁移**不保留** `session_events` 里的 delta、warning、source、file：它们本来就没有渲染消费者（见 12.4）。

#### 13.7 一并删除的代码

`sqliteJournal.ts`、`memoryJournal.ts`、`projection.ts`（`projectSession`）、`recovery.ts` 的事件重放、`sessionRuntimeJournal.ts`、`transcriptBridge.ts` 的双通道、`draftCheckpoint.ts`、`sessionRows.ts` 里 message/draft/revision 相关函数、`schema.ts` 里 4 张表、`restore.ts` 里的事件恢复分支。

保留并改造：`memoryStore.ts`（内存视图）、`stepExecutor.ts` 的漏斗、`errorSummary` / `tokenEstimate` / `context/*`（与存储无关）。

#### 13.8 测试清单

已落地（`packages/shared/test/sessionItems.test.ts`）：

- 折叠：`user + text + tool-call + tool-result + text + turn-end` → 两条消息，text 为无分隔拼接，parts 顺序正确。
- 折叠：缺失 `turn-end` 且无 `open_turn_id` → interrupted；`open_turn_id` 指向它 → streaming / tool `running`。
- 折叠：`tool-call` 无 `tool-result` + `turn-end.failed` → part `failed`。
- 折叠：交接消息保留 `authorAgentId` 与 `audience: bot`；同一 Turn 里更早的消息不因后者失败而改状态。
- 折叠：乱序输入按 `seq` 排序；只有 `turn-end` 的 Turn 不产出消息；孤儿 `tool-result` 抛错。
- schema：`turn-end` 缺 `turnId`、带 `messageId`、`interrupted` 无原因；part 类缺 `messageId`；`user` 带作者或非 `complete`；`tool-call` 非 `complete`；未知 `kind` —— 全部拒绝。

P1 已落地（`apps/agent/test/core/transcript/sessionItemsMigration.test.ts`）：

- 旧 schema 只靠新 migration 升级后，`sessions` 列集合与当前 baseline 相同、`session_items` DDL 逐字相同；
- 完成 Turn、失败 Turn、交接、开场、崩溃草稿、空白占位六类旧数据的折叠结果与 `restoreConversationSnapshot` 一致；
- 草稿只在 `base_revision === revision` 时合并；
- `next_seq` = 最后分配的 seq + 1，`message_count` 只数产出了条目的消息；
- 同一 `item_id` 重复插入 no-op；`afterSeq` + `limit` 分页。

P2a 已落地（`apps/agent/test/core/transcript/sessionItemStore.test.ts`，内存与 SQLite 两套实现共用同一组用例）：

- 追加幂等：同一 `item_id` 写两次，条目数不变，`next_seq` 只前进一次；
- `message_count`：part 条目按 `messageId` 首次 +1，`user` 条目按 `itemId`（它没有 `messageId` 列）；
- `finishTurn`：`turn-end` 与 `open_turn_id` 清空同事务；第二次收口 no-op；
- `appendItems` 不覆盖 `openTurnId`；`beginTurn` 置位后写入正文仍保持指针；
- 分页 `afterSeq` + `limit`；`clear` 后 `seq` 从 1 重新开始；
- 会话不存在时写入失败（不静默建行）。

随 P2b–P5 补：

- `seq` 倒序 + 游标不重不漏（历史列表分页）；
- 客户端：snapshot（含半截）+ 后续条目按 `item_id` 覆盖，正文不重复。

P2b-1 已落地（`packages/shared/test/sessionFrame.test.ts`、`packages/ui/test/conversationItems.test.ts`）：

- `sessionFrameSchema.event` 接受 `session-item`，与 durable 事件共用同一 `seq` 游标；条目不合法（缺 `messageId` 的 part）被拒；
- 客户端按 `item_id` 替换而非追加：快照半截正文被完整条目覆盖，多条 text part 无分隔拼接，tool-result 按 `toolCallId` 回填，`turn-end` 结算该 Turn 最后一条消息与未结算工具；缺 `tool-call` 的结果帧被丢弃（等整段重读补齐）。

P2b-2a 已落地（纯新增，不接线）：

- `apps/agent/src/core/transcript/sessionItemDrafts.ts`（`sessionItemDrafts.test.ts`）：内存消息 + 流事件 → 条目草稿。`text-end` / `reasoning-end` 从中已结算 part 读全文；`tool-execution-finished` / `tool-result` / `tool-error` / `tool-output-denied` 映射同一 `item_id`；没有对应 `tool-call` 的结果直接跳过（孤儿结果会让折叠 fail-closed）；Turn 收口时补写「内存已有、库里没有」的未结算 part 与缺失的工具结果。
- `apps/agent/src/core/session/sessionTurns.ts`（`sessionTurns.test.ts`）：条目 → Turn 投影决定 `queued` / `running` / `aborted` / 终态；没有 `turn-end` 且只有 user 条目的 Turn 进 `pending`（可重新入队），有内容的按进程退出收口。恢复计划为缺失的工具调用补 `tool-result{error}`，再补 `turn-end{interrupted, process-exit}`；`stepCount` 记 0（崩溃前没有 step 事实），`toolCalls` 从条目统计。重复执行幂等。
- 条目里没有 Bot 身份与 Turn 来源（user 条目按 schema 不携带作者），投影与恢复因此显式接收 `{ agentId, source }` 默认值，不从内容推演。

P2b-2b 已落地（原子切换，测试基线为 agent 801 / desktop 378 / cli 393 / ui 352 / shared 67 / remote 48 / config 11 / remote-node 4 / mobile 6）：

- 写入：`core/session/itemRecorder.ts` 成为唯一漏斗（内存视图 → 条目 → 帧）；`SessionRuntime` 的注入端口由 `sessionJournal?` 改为 `sessionItems?: SessionItemStore`，桌面与 CLI 传 `store.items`，answer 域固定使用独立 `MemorySessionItemStore` 且 SQLite `create(scope: "answer")` 直接旁路。
- 读通道：`readFramesAfter` 读条目并包装成 `session-item` 帧，与 live 帧共用 `seq`；`remote` / `mobile` 传输层零改动；`SessionFrameBus` 的 durable 订阅只收条目帧。
- 恢复：`planSessionRecovery` 按「有内容无 `turn-end`」补缺失 `tool-result{error}` 与 `turn-end{interrupted, process-exit}`，只有 user 条目的 Turn 重新入队；顺序固定为「事实收口 → `store.refresh` → queued 续跑」。
- 语义收口：`turn-end.stepCount` 在恢复收口记 0，`toolCalls` 从条目统计；`SessionScheduler` 从投影读取 `activeTurnId`，仍有 running 但无本进程执行器时视为 busy，避免与陈旧 Turn 并发写；`SessionTurnExecutor.steps` 改为实际执行的 step 数。
- 压缩不再写 journal 事实：删除 `ContextCompactor` 的 `onCompaction` / `ContextCompactionFact` / `ContextCompactionObserver`，生命周期只落 `ContextState.compaction`。
- 随切换删除：`journal.ts`、`memoryJournal.ts`、`sqliteJournal.ts`、`eventFactory.ts`、`sessionTurnProjection.ts`、`projection.ts`、`recovery.ts`、`sessionRuntimeJournal.ts`、`transcriptBridge.ts`、`draftCheckpoint.ts`、`sessionMessageMap.ts`、`sessionConflict.ts`，以及测试里的 `sqliteConversationMessages.test.ts`（测的是已删除的 `session_messages` / draft 语义）。
- 实现期修正：各 application 在 `store.create` 后显式调用 `SessionRuntime.createSession`（内部 `items.create`，幂等），否则直连 store 的路径会缺内存条目；`SqliteConversationStore.create` 对已加载会话同样比对 `metadata.scope`；`advanceLastSeq` 在 SQLite 下只作内存视图游标，未加载会话时 no-op，快照 `lastSeq` 由条目推导。

#### 13.9 实现期修正与批次

- **P1 不删旧表。** 第 13.6 节原先写「迁移时删 5 张表」，实际拆到 P4：P1 只建 `session_items` 并回填，旧表和 `revision` 保留，迁移结果可与旧读路径逐条比对，出问题也能回退。P4 再删表并移除 `legacySessionImport` 的 meta 标记。
- **P2 不能单独落地。** `SessionJournal` 同时是写入口和 durable 读通道（桌面 / CLI / remote 的 `readFramesAfter`）；删 journal 的同一笔必须把读通道换成条目，否则历史补齐立即断链。因此 P2 与 P3（恢复）同批。
- **帧协议先加兼容变体。** 第二批把 `sessionFrameSchema.event` 扩成 `z.union([agentDurableEventSchema, { type: "session-item", item }])`；`remoteFrameListSchema` 与 `RemoteSessionFrame` 复用同一 schema，所以 remote / mobile 传输层零改动。P5 再做独立的 `SessionItemFrame` / `SessionStatusFrame` 重命名与传输层收口。
- **`turn-end` 追加 `reason`。** P0 只有 `finishReason`（provider 最后一步终因），会丢掉 `cancelled` / `handoff-failed` / `context-exhausted`；`reason?: TurnFinishReason` 与 `finishReason` 并存，各表一件事。
- **`open_turn_id` 只在 Turn 开始时置位**，提交时不置；理由见第 5 节。
- **客户端折叠按 `item_id` upsert 必须在第二批做**：snapshot 可能已带内存半截，同一 part 随后以完整条目到达，盲追加会出现双份。
- **第二批再拆一步（P2a）。** 先把条目存储端口与两套实现（内存 / SQLite）单独落地并测透，旧写路径不动；P2b 再一次性切换写入、读通道、恢复与帧协议。这样「存储语义错了」和「接线错了」不会是同一个提交，回退粒度也更小。
- **P2b 再拆两步（P2b-1 / P2b-2a）。** P2b-1 只把帧协议扩成兼容变体并让客户端按 `item_id` upsert；P2b-2a 只落「条目草稿」与「Turn 投影 / 恢复计划」两个纯函数模块及其单测，仍不接线。P2b-2b 才原子切换写路径、读通道、恢复与各领域接线，并删除 journal 相关实现。
- **`store.create` 不再隐式建条目存储。** 条目存储是独立端口，直连 store 的测试与恢复路径不会经过 `SessionRuntime`；因此各 application 在 `store.create` 后显式调用 `SessionRuntime.createSession`，否则内存实现会因「会话不存在」拒绝写条目。SQLite 实现由 `SqliteConversationStore.create` 自己保证幂等。
- **`advanceLastSeq` 降级为内存游标。** 条目 `seq` 已经是 durable 事实，再持久化一份游标就会产生第二份真相；SQLite 适配器只在会话已加载时推进内存快照，未加载时 no-op，`load` 用条目重建 `lastSeq`。
- **恢复投影里的 running 也算 busy。** 恢复只补事实、不重启旧 Turn；若此时放行新排队 Turn，就会出现两个写者。`Scheduler` 因此从投影取 `activeTurnId`，有值即拒绝启动新 Turn，等旧 Turn 收口后再放行。

## 模块边界

| 写入方 | 允许写的表 | 禁止 |
| --- | --- | --- |
| `core/session`（Turn/Step 编排与恢复） | 通过条目端口追加 `session_items`，并维护 `open_turn_id` / `next_seq` / `message_count` | 不执行 SQL，不保存第二份 Turn 状态，不重放副作用 |
| `core/transcript`（store、SQLite 适配、折叠） | `sessions`、`session_items` | 不判断 Turn 语义，不做恢复决策 |
| `packages/shared/src/schema/session/fold.ts`（条目 → 消息） | 只读 | 不写库、不带 IO、不依赖领域 |
| 各领域 application | 只调 store 与 session 端口 | 不拼 SQL，不解析条目 |
| 客户端折叠（`packages/ui` 的 `foldConversationFrame`，桌面 / CLI TUI / 移动端共用） | 只读 snapshot、item frame、status frame | 不推演缺失状态；按 `item_id` upsert，不盲追加 |
| live 通道 | 内存 → 传输 | 不落库，不要求与条目对齐 |

`packages/shared/src/schema/events.ts` 保留为 **live 通道契约**（UI 与 CLI 的实时帧），不再承担持久化事实的角色。`AgentDurableEvent` 的既有措辞（「仅规定未来适配器的事件资格」）正好允许这次转向。

## 曾考虑的替代方案

- **事件权威 + 消息投影（3 表）。** 舍弃。它买到「可从日志重建」，代价是双写对账、`replay == 投影` 不变量、以及 append-only 的 upcaster 长期税；产品没有时序查询、多投影或多写者同步需求。
- **JSONL 文件日志 + SQLite 投影（Codex 路线）。** 舍弃。第二套存储、投影游标、压缩、坏行跳过都要自己实现；它同样只为「可重放」付费。
- **消息级单表（一行一条 `ConversationMessage`）。** 舍弃。结算单位是 part，按消息落库会让整轮都等最后一步，中途崩溃丢整轮。
- **保留 `session_turns`。** 舍弃。Turn 状态由 `turn-end` 条目表达；单开一表就是第二份真相。
- **保留 `session_message_drafts` 并把节流窗口调大。** 舍弃。整行重写仍是 O(N²)，调窗口只改常数；而且它破坏了 I3。
- **条目里存 `role`。** 舍弃。`kind` 唯一决定角色，多存一列只会多一种自相矛盾的可能。
- **给 `tool-call` 存 `running` 状态。** 舍弃。那需要事后再 UPDATE 这一行，直接违反 I1/I3；「在跑」是折叠推导值，不是持久化状态。
- **提前加 fork / parent 列。** 舍弃。功能不存在，列永远是 NULL；真做时加一次 `ALTER TABLE` 即可。
- **事件溯源：delta 也持久化。** 舍弃。delta 事件量是内容长度的数倍，事件表会先于消息表失控。
- **崩溃也保尾（草稿行）。** 舍弃。代价是重新引入非终态行与恢复判定，收益只是崩溃时多留最后半句。
- **`session_jobs` / `session_inbox`。** 暂不建。后台任务与排队都可以由条目表达（见第 11 节）；只有事件或条目开始被裁剪时，才需要独立的义务表。
- **保留 `revision` 乐观锁。** 舍弃。同库没有第二个写者；多写者时它也只能事后报冲突。
- **保留 `meta` 表做通用 KV。** 舍弃。当前只有旧 JSON 导入标记一个用途，扫描归档目录即可。

## 验收标准

- 可观察结果：
  - 数据库只有 2 张业务表（+ `_migrations`），没有 `session_events`、`session_messages`、`session_turns`、`session_message_drafts`、`meta`。
  - 代码里不存在对 `session_items` 的 UPDATE 语句（只追加）；重放同一条结算两次，条目数不变。
  - 流式中杀进程：已结算的条目全部保留；未结算的那一步不出现半截；重新打开会话后该 Turn 有 `turn-end{interrupted, process-exit}`，`open_turn_id` 为 NULL。
  - 点停止：已生成正文以 `text{interrupted}` 落库，未结算工具补 `tool-result{failed}`，`turn-end{interrupted, cancelled}` 与清指针同事务，正文不丢。
  - 取消排队中的 Turn：只多一行 `turn-end{interrupted, cancelled}`，不再出现该 Turn 的 assistant 条目。
  - 崩溃恢复后，该 Turn 的每个 `tool-call` 都有终态 `tool-result`；模型历史里不存在悬挂的 `tool-call`。
  - 发送时崩溃且尚未发出任何模型请求：重新打开会话后该 Turn 重新入队，且不会重复写入 user 条目。
  - 一条消息由 N 行折叠：`assistant` 消息含 text + tool，`message.text` 等于 text 条目拼接；`authorAgentId` / `audience` 折叠后与原消息一致。
  - 客户端在流式中途连上：snapshot 给出已结算条目 + 当前半截，后续条目到达后正文不重复、只被补全（按 `item_id` 覆盖）。
  - 断点续传：从任意 `seq` 继续返回条目，不重不漏；分页按 seq 倒序稳定。
  - 远程与移动端：`RemoteSessionFrame` 与桌面折叠结果一致；断线重连后从 snapshot 补齐，不出现重复文本。
  - 历史面板的「N 条消息」与 `SELECT COUNT(*)` 一致；空会话不出现在列表里。
  - 压缩检查点用 `throughMessageId`，`state_json` 不含正文。
- 自动化验证：
  - `packages/shared/test/schema.test.ts`：条目种类与 `payload` 形状、live 事件目录。
  - `apps/agent/test/core/session/`：折叠函数、`next_seq` / `message_count` 分配、`turn-end` 与 `open_turn_id` 同事务、恢复三类场景幂等、重复追加 no-op。
  - `apps/agent/test/core/transcript/`：只追加语义（无 UPDATE 路径）、分页游标、迁移后折叠等价、大工具输出截断。
  - 迁移测试：升级后旧表不存在，条目折叠结果与原消息等价，`streaming` 行转为 `interrupted` 且有 `turn-end`。
- 需要的实机验证：
  - CLI coding 跑一次含长工具输出与手动中断的会话，重启检查条目完整性与 Turn 收口。
  - 桌面 conversation 断点续传一次长回答；截图答题（answer 域只走内存，验证不受影响）。

## 风险

- **崩溃丢尾巴。** 已明确接受：未结算的那一步随内存消失。若将来必须保尾，只能引入草稿行，I3 与「无中间态」的收益随之消失，需要整篇重估。
- **读要折叠。** 一条消息由多行拼出，热路径从「一次查询一行」变成「一次查询 N 行 + 折叠」。折叠是纯函数、可测试；但分页必须按 seq 而不是按消息，调用方要习惯。
- **单条条目仍整行写。** 没有反复重写，所以不会回到 O(N²)；但单行仍有体积上限，所以第 9 节的截断是硬性前提。
- **`turn-end` 是唯一的 Turn 终态来源。** 折叠可以容忍它缺失（按 interrupted 渲染），但「这一轮是什么原因结束的」只能从它读。它必须与 `open_turn_id` 同事务，任何绕过端口的写入都会破坏 I5。
- **`message_count` 是冗余计数。** 它必须和条目追加同事务，否则历史列表会显示错数。写入口只有一个，风险可控；如果将来出现第二个写者，改成列表时 `COUNT(DISTINCT message_id)`。
- **惰性恢复有盲区。** 只有被打开/提交/连接的会话才会写回 `turn-end`；长期不再打开的会话会保留悬挂 Turn。折叠把它显示成中断，所以这不是数据正确性问题，只是「收口会延后」。
- **没有 user 消息的排队 Turn 不再持久化。** 面试 `reply` / `opening` 排队后崩溃，重启不会再自动续跑（见 12.5）。这是唯一一处明确缩小的耐久面；要恢复就得加 `turn-start` 条目。
- **会话级状态多了一条可丢通道。** 用量、压缩、活动 Turn 不再有 durable 事件兜底，断线期间的变化只能靠下一次 snapshot 修复。状态帧丢失只影响进度条与 spinner，不影响正文。
- **没有审计与重放。** 无法事后证明「每一步喂了什么给模型」。需要时加单次运行的 trace 快照文件（一个 JSON，非 JSONL，只用于调试，不作正确性来源），不加表。
- **会话级 `seq` 是串行写。** 单写者下没有竞争；出现多宿主并发编辑时，要升级为带 fencing 的写者声明，仍不需要业务表。
- **迁移不可逆。** 旧表的正文折成条目后无法还原原 `message_json` 的字段顺序；上线前先在开发库演练一次迁移与恢复。
