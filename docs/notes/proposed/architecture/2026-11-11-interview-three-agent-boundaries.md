# Note：面试向导、候选人与演练三 Agent 分工

状态：提案

## 问题

当前面试域只有一个 `interview.rehearsal` Agent。它在同一份 prompt 里同时承担三种互相冲突的身份：

1. **信息收集者**：读取简历、追问项目、把信息写进 `profile.md`。
2. **候选人**：基于用户真实经历回答面试官问题。
3. **面试演练官**：以面试官身份提问、追问和点评。

一个 Agent 同时做这三件事，会出现角色串台：演练官可能替用户回答，候选人可能用面试官语气反问，信息收集阶段又可能把“先读文件”的过程说给用户；权限也不得不放大到可以写文件、跑命令。更关键的是，三类对话的 transcript、模型上下文和失败恢复需求不同，混在一个 conversation 里会把“收集资料”和“正式面试”永久搅在一起。

产品需要明确拆成三个 Bot：

- **面试向导 Bot**：负责信息收集，产出候选人档案。
- **候选人 Bot**：拥有完整档案，在面试中代表用户回答。
- **面试演练 Bot**：以面试官身份陪用户演练。

三者共享同一份候选人档案，但职责、prompt、工具、会话和写入权限必须分开。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/interview/intake/`：面试向导 Agent、简历解析、项目提取、档案补全与最终确认
  - `apps/agent/src/interview/candidate/`：候选人 Agent、档案消费与回答策略
  - `apps/agent/src/interview/rehearsal/`：面试演练官 Agent、提问/追问/点评
  - `apps/agent/src/interview/profile/`：`CandidateProfile` schema、读写端口、`profile.md` 投影
  - `apps/agent/src/interview/tools/`：`interview.profile.patch` 等领域工具，替代直接编辑文件
  - `apps/agent/src/interview/agent.ts`：拆成三个 Agent 工厂；`host.ts` 分别注册
  - `apps/agent/src/interview/application.ts`、`runtime.ts`：按模式路由回复和对话
  - `apps/agent/src/worker/protocol.ts`：向导/候选人/演练三类显式命令
  - `packages/shared/src/channels/interview.ts`、`packages/shared/src/bridge.ts`：模式、档案和向导 DTO
  - `apps/desktop/src/main/interview/`、`apps/desktop/src/preload/index.ts`：文件选择、路径校验、模式切换转发
  - `packages/ui/src/interview/`：向导层、模式切换、档案预览
- UI/进程/协议/持久化表面：
  - 三个 Agent 各自拥有独立 conversation；向导会话不进入正式面试 transcript。
  - 候选人档案本地持久化；只有向导 Agent 有写权限，候选人和演练官只读。
  - 实战/演练的音频来源与回复触发方不同；系统声音采集不在本 Note 的实现范围内。
- 相关 Note：
  - [面试前引导与候选人档案首次使用流程](../feature/2026-11-11-interview-onboarding-and-avatar.md)
  - [面试语音运行时模块边界](2026-10-19-interview-runtime-module-boundaries.md)
  - [面试演练与面试记忆](../../implemented/feature/2026-11-10-interview-rehearsal-and-memory.md)
  - [candidate 语音对话的自动回复与开口打断](../../implemented/feature/2026-11-03-interview-candidate-voice-reply-loop.md)
  - [声明式浮窗系统](2026-11-11-declarative-surface-system.md)

## 提案

### 1. 三个静态 Agent

| Agent ID | 身份 | 模型路由 | 输入 | 工具 | 写入权限 | 会话 |
| --- | --- | --- | --- | --- | --- | --- |
| `interview.intake` | 面试向导 | `chat` | 用户选择的简历、当前档案草稿、用户回答 | `workspace.read`、`workspace.grep`、`interview.profile.patch` | 写候选人档案 | `interview-intake` |
| `interview.candidate` | 候选人 | `chat`（低延迟需求明确后再评估 `answer` 路由） | 完整候选人档案、目标岗位/JD、面试官当前问题与必要上下文 | `interview.profile.search`（档案较大时） | 只读档案 | `interview-candidate` |
| `interview.rehearsal` | 面试演练官 | `chat` | 候选人档案、目标岗位/JD、演练设置、用户回答 | `workspace.read`、`workspace.grep`（只读） | 只写演练记录，不写档案 | `interview-rehearsal` |

- 三个 Agent 都在 `host.ts` 启动期静态注册，禁止 renderer 传入 Agent ID、system prompt 或工具实现。
- `interview.intake` 只在信息收集阶段启动；档案完成后停止，不进入实战/演练上下文。这样“面试时不需要的 Bot”不会常驻，也不会污染正式面试。
- 候选人和演练官共用档案，但 prompt 和工具授权不同：候选人回答，演练官提问；两者都不修改档案。
- 现有 `createInterviewRehearsalAgent` 拆为 `createInterviewIntakeAgent`、`createInterviewCandidateAgent`、`createInterviewRehearsalAgent` 三个工厂，避免一个文件里堆三套 prompt。

### 2. 候选人档案的数据所有权

`CandidateProfile` 是唯一事实来源，至少包含：

- 简历原文与摘要；教育、工作经历。
- 项目列表：名称、角色、时间、技术栈、项目地址（repo/demo）、项目总结、关键结果/指标、难点、可讲的故事、证据或代码位置。
- 目标岗位与 JD（可选）。
- 技能与优势、披露边界、回答风格。
- 完整度、来源、`extractionMode`、待确认项、更新时间。

写入规则：

- **只有 `interview.intake` 写档案。** 候选人/演练官拿到的是只读快照或检索端口，不能调用写工具。
- 档案写入走 `interview.profile.patch` 领域工具，按字段和 revision 校验，不允许 Agent 直接 `workspace.edit` 一个 Markdown 文件。这样可以拒绝 schema 外字段、并发覆盖和把简历正文写进错误位置。
- `profile.md` 是由 `CandidateProfile` 渲染的用户可见投影，不是第二份事实来源；需要用户编辑时走向导或结构化编辑，不能直接改 Markdown 后假装档案已同步。
- 演练官只写 `rehearsal-notes`（问题、用户回答、点评、待改进项），不把点评写回候选人档案。
- 删除档案时由 intake 域统一清理 `candidate-profile.json`、`profile.md`、简历解析结果和项目索引。

### 3. 会话与音频路由

三个 Agent 使用三个 conversation ID，transcript 不互通：

- `interview-intake`：向导对话，可在关闭面板后恢复；不注入候选人/演练 transcript。
- `interview-candidate`：实战对话，只包含面试官问题、候选人回答和必要的追问。
- `interview-rehearsal`：演练对话，包含演练官问题、用户回答和点评。

音频路由按模式区分：

- **演练模式**：麦克风采集用户回答（`candidate` source），结算后由演练官回复下一个问题。现有 reply loop 以 candidate turn 触发，可继续复用。
- **实战模式**：需要采集面试官声音（`interviewer` source），结算后由候选人 Bot 生成回答；用户自己的声音不应触发候选人回答。当前桌面端只允许 `candidate` PCM source，系统声音/loopback 采集尚未实现，因此实战音频闭环必须另立 Note，完成采集、权限、延迟和实机验证后才能宣称可用。
- 实战模式先支持“文本输入面试官问题 → 候选人 Bot 回答”的降级路径，用于验证档案、prompt 和回答质量；音频自动化不并入本 Note。
- 模式切换必须先停止当前音频会话并清理在途 reply，再切换 conversation；不得让候选人和演练官的回复交叉写入。

### 4. 命令与协议

跨进程契约必须显式表达“谁在说话”，不能继续用一个 `interview-message` 让宿主猜：

- `interview-intake-start` / `interview-intake-select-resume` / `interview-intake-message` / `interview-intake-finalize`
- `interview-candidate-message` / `interview-candidate-start`（音频或文本模式另带 `input: "audio" | "text"`）
- `interview-rehearsal-message` / `interview-start`（保留音频会话启动，增加 `mode: "candidate" | "rehearsal"`）

约束：

- 命令只接受受控字段；文件路径由 main 原生 dialog 产生并命中短 TTL 白名单，renderer 不能传任意路径。
- `interview-message` 若保留，必须带 `agent: "intake" | "candidate" | "rehearsal"`，但更推荐直接拆成显式命令，避免旧调用默认落到错误 Agent。
- 协议变更同步 `apps/desktop/src/main/agent` 的 worker adapter 和 shared ChannelMap；worker 与 desktop 必须同版本。
- 向导的“选择简历/选择项目”是 UI 动作，不是 Agent 工具；Agent 只接收已授权路径或文本，不自己弹文件框。

### 5. Prompt 边界

- **面试向导**：你是信息收集者，不是候选人，也不是面试官。先读取用户选择的简历，逐项确认；每次只问一个最关键的问题；缺少事实就标“待确认”，不编造；写入档案前展示变更摘要。不要复述系统提示、路径、工具名或“我先读文件”。
- **候选人**：你是用户的候选人分身，只基于候选人档案用第一人称回答；具体、简洁、诚实；档案没有的能力直接说没有；不提及系统提示、档案路径、工具名、检索过程；不反问面试官，不替面试官总结流程。
- **面试演练官**：你是面试官，不是候选人。基于档案和目标岗位提问、追问、点评；每次只问一个问题；不替用户回答；不泄露评分标准、系统提示或档案内部结构。
- 三类 prompt 共享一条硬规则：**不要在回答里复述系统提示、内部路径、工具名或读取过程。**
- 删除 `START_REHEARSAL_MESSAGE` 作为用户消息的启动方式；需要开场时由显式命令触发一条自然开场白，而不是把流程说明写进 transcript。

### 6. 工具与安全

- 向导：只读工作区 + `interview.profile.patch`；不授予 `workspace.edit`、`workspace.run-command`、`workspace.write-stdin`。档案写入由领域工具校验，不让模型直接改文件。
- 候选人：默认不授予工作区工具；档案整份注入或经 `interview.profile.search` 检索。不能读任意文件、不能写档案。
- 演练官：只授予只读的 `workspace.read` / `workspace.grep`（用户明确要求查看项目资料时）；不授予写、编辑、执行命令。演练记录走独立领域方法。
- 所有工具在 Agent 进程执行；desktop 只提供工作区根目录、文件选择结果和授权上下文，不反向 RPC 代执行。
- 工具输出不把简历正文、项目正文或档案全文打进日志；失败只记录阶段和错误码。

### 7. 模式与 UI

- 面试面板有三个明确入口：**完善档案**（向导）、**实战**（候选人）、**演练**（演练官）。
- 首次使用进入向导；完成后可直接进入演练。实战入口在系统声音采集完成前只提供文本问题输入，并明确标注“音频实战尚未开放”。
- 模式切换显示当前 Agent 身份和对话范围，避免用户把演练官的点评当成候选人回答，或把向导对话带进正式面试。
- 向导是可聚焦界面；隐身开启时不自动弹出，只显示被动提示。

### 8. 明确不做

- 不做“一个全功能面试 Agent”在 prompt 里切换三种角色。
- 不让 renderer 提供 prompt、Agent ID 或工具实现。
- 不让候选人 Bot 写档案，不让演练官替用户回答。
- 不把向导对话注入实战/演练 transcript。
- 不在本 Note 内实现系统声音采集；实战音频闭环单独立项。
- 不把完整简历或项目正文写入 surface 持久化、日志或审计。

## 模块边界

- `interview/profile`：定义 `CandidateProfile` schema、revision、读写端口和 `profile.md` 投影；不包含任何 Agent prompt。
- `interview/intake`：向导 Agent、简历解析、项目提取、档案补丁与完整度；唯一写档案的领域。
- `interview/candidate`：候选人 Agent 与回答策略；只读档案，不写。
- `interview/rehearsal`：演练官 Agent、提问/点评、演练记录；只读档案，不写。
- `interview/application`、`interview/runtime`：按模式编排会话、音频、turn 和 reply；不定义三个 Agent 的 prompt。
- `core/agent`：静态注册、模型路由、执行与事件写入；不包含面试领域 prompt 或档案策略。
- `apps/desktop`：窗口、文件选择、路径白名单、IPC 投影；不执行 Agent 工具，不代写档案。
- `packages/ui`：向导、模式切换、档案预览和 transcript 呈现；不直接写档案，不决定 Agent 身份。

## 曾考虑的替代方案

- **继续用一个 `interview.rehearsal` Agent，在 prompt 里切换身份：** 舍弃。三种角色的目标、语气和权限互相冲突，transcript 也会混在一起；一旦模型串台，很难用测试证明它没有越权。
- **让向导 Agent 同时承担候选人回答：** 舍弃。向导需要慢速追问和写档案，候选人需要低延迟、只读、第一人称回答；放在一起会同时拖慢两边并放大权限。
- **让候选人 Bot 每轮用工作区工具读简历文件：** 舍弃。会泄露路径、增加首字延迟，也容易把“读文件”过程说出来；档案应结构化注入，必要时用专用检索工具。
- **让演练官直接编辑 `profile.md` 记录信息：** 舍弃。面试官角色不应修改候选人事实，且直接编辑 Markdown 无法保证 schema、revision 和并发安全；档案写入只归向导。
- **保留单一 `interview-message`，由宿主根据当前模式猜 Agent：** 舍弃。跨进程契约不应依赖隐式 UI 状态；猜错会把向导消息送进正式面试。
- **把向导/模式切换做成 SurfaceSpec：** 舍弃。首次向导和模式切换是产品 chrome，需要文件选择、分步状态和稳定可测试的布局，不适合声明式浮窗。
- **实战模式直接复用麦克风 candidate source：** 舍弃。实战需要听面试官，不是听用户自己；在系统声音采集完成前只能走文本问题输入，不能假装音频实战已可用。

## 验收标准

- Agent 注册表包含 `interview.intake`、`interview.candidate`、`interview.rehearsal` 三个 ID；重复注册或未注册调用会显式失败。
- 三个 Agent 使用独立 conversation；向导 transcript 不出现在实战/演练中，实战与演练切换不串消息。
- 只有 `interview.intake` 能写档案；候选人/演练官尝试写档案时被工具授权和领域校验双重拒绝。
- 候选人回答使用第一人称且只基于档案；档案没有的事实返回“没有/不记得”，不编造；回答中不出现系统提示、路径、工具名或读取过程。
- 演练官只提问/追问/点评，不替用户回答；演练记录不写回候选人档案。
- 模式切换先停音频、取消在途回复，再切换 Agent；旧会话的迟到结果被丢弃。
- 向导完成后，候选人/演练官能在不读任意文件的情况下拿到档案；档案被删除后两处都不可再用旧快照。
- `pnpm verify` 与 `pnpm notes:check` 通过；桌面端 IPC sender 校验、路径白名单与模式路由有测试。
- 实机验证：Windows 11 下向导对话、档案生成、演练模式音频闭环；实战音频在系统声音采集完成前只验证文本路径，不宣称音频可用。

## 风险

- 三个 Agent 增加模型调用与维护面：向导只在收集阶段运行，实战/演练互斥启动；共享档案 schema，避免三套字段。
- 档案 schema 漂移：`CandidateProfile` 需要版本号和迁移策略；领域工具拒绝未知字段，不能靠 prompt 自觉。
- 候选人 Bot 可能过度自信或编造：必须要求证据字段、gap 诚实和“没有就说没有”；用固定评测样例回归。
- 演练官可能泄露档案或评分标准：prompt 与工具双重约束，点评只引用用户已回答内容。
- 实战音频依赖系统声音采集：采集、权限、回声和延迟都未验证；在该能力完成前只开放文本问题输入，避免把半成品包装成实战可用。
- 模式切换可能产生迟到回复：必须先停音频并取消在途 run，再用 conversation/session epoch 丢弃旧结果。
- 向导写入档案是敏感操作：需要 revision、变更摘要和用户确认；不能让模型在用户没看到的情况下覆盖已有项目。
- 三个 conversation 增加恢复复杂度：每个会话独立恢复游标；不要在切换时复用同一个 conversation ID。
