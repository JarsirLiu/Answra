# Note：面试 intake 对话页与画像补全

状态：已实施

## 问题

面试引导完成后，`InterviewFeaturePanel` 目前停在 `InterviewAvatarPanel`：有资料时显示“面试分身制作中 / 制作能力接入中”，无资料时显示“还没有面试资料”。这张卡片只有三步占位和资料摘要，没有任何 Agent 真正读取简历、查看项目或补写 `profile.xml`。引导本身只保存 `wizard.json`，有资料时创建首份 `profile.xml`，但“制作”仍是一个未兑现的状态。

用户明确产品意图：完成或跳过引导后**直接进入面试页面**，AI 直接开始写记忆；需要补充信息时就在对话里问，或以后用浮窗卡片让用户确认/填写。卡片不需要与 `profile.xml` 字段绑定，也可以后置。因此“制作面试分身”不是后台构建任务，而是进入页面后的第一次 intake 对话。

此前讨论过的 `building / ready / failed` 状态机、制作进度条和独立“制作任务”不是既有提案内容，也没有用户需要；它会把一次普通 Agent 对话变成第二套持久状态，并容易让 UI 伪造进度。原 Note 只要求把引导资料交给后续 Bot，并明确不伪造制作进度。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/app/InterviewFeaturePanel.tsx`：完成/跳过后改为进入 intake 对话页，不再进入静态制作卡片。
  - `packages/ui/src/interview/intake/`：新的对话页、消息区、输入区、页头与测试；复用现有 `ChatPanel` / `ConversationComposer` / `MessageStream` 原语。
  - `packages/shared/src/channels/interview.ts`、`packages/shared/src/bridge.ts`：新增 intake conversation ID、open/message/snapshot/events 契约。
  - `apps/desktop/src/preload/index.ts`：只转发 open/message/snapshot/events，不放业务逻辑。
  - `apps/desktop/src/main/interview/interviewIpc.ts`、`apps/desktop/src/main/agent/agentService.ts`：intake 显式命令、会话固定 ID、sender 校验、snapshot/events 转发。
  - `apps/agent/src/core/transcript/store.ts`、`apps/agent/src/core/transcript/memoryStore.ts`：新增无 user 消息的 `beginOpeningRun`，只追加 assistant 占位，不伪造用户消息。
  - `apps/agent/src/interview/application.ts`、`apps/agent/src/host.ts`：无音频的 intake 会话打开、开场 run、读快照与事件；intake 与演练各自持有独立 `InterviewApplication`。
  - `apps/agent/src/interview/intake/`：`interview.intake` Agent、prompt、工具授权与开场指令。
  - `apps/agent/src/interview/profileContext.ts`：`profile.xml` 路径、格式提示和只读种子渲染，供 intake 写、rehearsal 读。
  - `apps/agent/src/interview/rehearsal/profile.ts`、`apps/agent/src/interview/agent.ts`：演练官降为只读，不再维护画像。
  - `apps/agent/src/worker/protocol.ts`：新增 intake 显式命令。
  - `packages/ui/src/components/panels/ChatPanel.tsx`：增加标题、intake 变体、输入提示、无附件模式和页头动作；不复制消息投影。
- UI/进程/协议/持久化表面：
  - 完成/跳过引导后直接显示对话页；`pending` 仍显示引导。
  - 新增 `interview-intake` conversation，与音频/演练的 `active-interview-conversation` 分开，transcript 不互通。
  - 页面不新增制作状态或进度；AI 的读取、写入和提问按普通对话与工具调用呈现，不显示制作阶段。
  - `profile.xml` 仍是唯一画像事实源；`wizard.json` 继续保存引导输入；不新增制作状态文件。
  - 只有 `interview.intake` 写画像；演练官只读。renderer 不传 prompt、工具实现或任意文件路径。
- 相关 Note：
  - [面试前引导与候选人档案首次使用流程](../../proposed/feature/2026-11-11-interview-onboarding-and-avatar.md)
  - [面试向导、候选人与演练三 Agent 分工](../../proposed/architecture/2026-11-11-interview-three-agent-boundaries.md)
  - [面试演练与面试记忆](2026-11-10-interview-rehearsal-and-memory.md)
  - [面试语音运行时模块边界](../architecture/2026-10-19-interview-runtime-module-boundaries.md)
  - [声明式浮窗系统](../../proposed/architecture/2026-11-11-declarative-surface-system.md)
  - [candidate 语音对话的自动回复与开口打断](2026-11-03-interview-candidate-voice-reply-loop.md)

## 决定

实际落地为两套 `InterviewApplication`：演练继续走音频 runtime，intake 只走文本；两者共享 `ConversationStore`、Agent runtime 和 snapshot 广播，但 conversation ID、Agent、工具授权和 transcript 完全分开。`beginOpeningRun` 让空会话可以只追加 assistant 占位并启动模型，开场指令只进入模型请求，不写 user message。

`useConversationView` 增加可注入的 `getSnapshot` / `readEvents`，intake 页面注入 interview 域实现；通用对话页面保持原路径。`InterviewIntakePanel` 复用 `ChatPanel` 的消息流、Markdown、工具行和输入框，只增加 intake 标题、无附件输入和“资料”入口。

### 1. 入口：制作态改成 intake 对话页

- `InterviewFeaturePanel` 的 `pending` 状态继续渲染现有引导。
- `completed` / `skipped` 直接渲染新的 `InterviewIntakePanel`，不再渲染 `InterviewAvatarPanel`。头像卡片从入口移除；其视觉素材可以复用到页头，但不再出现“制作中”“制作进度”“制作能力接入中”这类占位。
- 页面就是面试分身的第一次对话：页头显示“面试分身”，正文是消息流，底部是文本输入框。有资料时 AI 先读资料再问；无资料（例如跳过引导）也直接进入对话，AI 先问目标岗位、简历或项目，不把“没有资料”当成阻断。
- 页面不显示制作阶段列表；模型读文件、写画像、提问都按普通对话和工具调用出现，用户只看到 AI 的消息、自己的输入和正常的运行错误。

### 2. 打开会话与一次性开场

新增显式命令和频道，不靠会话 ID 猜场景：

- `ActiveInterviewIntakeConversationId = "interview-intake"`，与 `ActiveInterviewConversationId` 分开；音频/演练 transcript 不进入 intake 页面。
- `answra:interview:intake-open`：请求只接受固定 intake conversation，不接受 renderer 传任意 conversation ID。
- `answra:interview:intake-message`：用户文本消息，复用 `InterviewApplication.sendText` 的落账和回复路径。
- `answra:interview:intake-snapshot` / `answra:interview:intake-events`：读取 intake 域的 snapshot 与事件；不能复用当前通用 `snapshot` / `read-events`，因为这两个命令走 conversation runtime。

`interview-intake-open` 必须幂等：

1. 会话不存在则创建 `interview-intake`，scope 为 `interview`。
2. 读取 snapshot；已有消息或已有 `activeRunId` 时只恢复页面，不重复开场。
3. transcript 为空且没有活动 run 时，启动一次开场 run。
4. 开场 run 使用领域输入 `opening: true`；模型请求里包含固定开场指令，但**不写一条假的 user message**。transcript 只出现 assistant 的开场消息。若现有 store/executor 不能在没有 user 消息时启动，则扩展领域输入或增加明确的开场标记，不允许把流程说明伪装成用户发言。
5. 开场 run 失败时不写 `ready` 或 `failed` 状态；页面保持普通错误提示，用户可以继续输入或再次打开。transcript 为空时再次打开可以重试开场。

开场不是独立状态：它和后续回复一样是一次普通 run；页面只依据 transcript、活动 run 和普通错误显示，不维护额外状态。

用户流程：

```text
引导完成/跳过
  → 进入 interview-intake 对话页
  → AI 读 profile.xml、简历、项目
  → AI 写 <memory>/<history>
  → 缺信息时一次问一个问题
  → 用户回答
  → AI 继续补写/追问
```

### 3. `interview.intake`：唯一画像写入者

新增静态 `interview.intake` Agent，模型路由为 `chat`，与演练官分开注册；不接收 renderer 提供的 Agent ID、prompt 或工具实现。

- **身份**：面试资料整理者，不是候选人，也不是面试官。它负责把用户真实经历整理进 `profile.xml`，用第一人称事实提问，不替用户回答面试问题。
- **输入**：`profile.xml` 路径、只读 `InterviewProfileSeed`（目标岗位、简历路径、选中项目）、工作区根目录、当前 transcript。
- **行为**：
  - 先读 `profile.xml`；不存在时按 seed 和用户当前输入创建首份画像，已有画像不覆盖。
  - 读简历绝对路径；PDF/DOCX 继续复用 Agent `Read` 现有能力，不新增解析库。
  - 本地项目位置用 `workspace.read` / `workspace.grep` 查看 README、包清单和关键源码；远程 URL 本轮只记录，不 clone，不联网抓取。
  - 把确认的事实、证据、待确认项写进 `<memory>`，更新 `updated` 和 `<history>`；保留未知字段和已有内容，不另建第二份画像。
  - 缺信息时一次只问一个最关键的问题；不编造项目、指标、职责或技术细节；不展示 XML 原文、绝对路径、工具名或读取过程。
  - 不把“已读简历”当成“画像已完成”；只有实际写入成功后才说资料已整理。
- **工具**：`workspace.read`、`workspace.grep`、`workspace.edit`。本轮不授予 `workspace.run-command`；远程 clone、安装依赖或执行项目命令不在制作范围内。
- **写入权**：intake 是唯一写 `profile.xml` 的 Agent。现有演练官从 `workspace.read/grep/edit/run-command` 收缩为只读 `workspace.read/grep`，prompt 改为“不修改画像”；候选人 Agent 留给下一提案。这样不会出现 intake 和演练官同时改画像。
- **上下文位置**：`profile.xml` 的路径、格式、seed 渲染从 `interview/rehearsal/profile.ts` 提到 intake/rehearsal 共用的画像上下文模块；两边只共享只读上下文，写入工具只在 intake。避免 intake 反向 import 演练官模块。

### 4. 会话读取与 UI 投影

- intake 页面复用现有消息投影、Markdown、工具行和输入框，不复制第二套 transcript 合并逻辑。
- `useConversationView` 增加一个可注入的读取源（`getSnapshot` / `readEvents`），intake 页面注入 interview 域实现；通用 conversation 页面继续使用现有实现。`onConversationEvent` / `onConversationSnapshot` 已经与领域无关，可以继续订阅。
- 页面首次挂载先调用 `openInterviewIntake`，再读取 snapshot 和事件。若返回开场 run，按普通 run 订阅事件；若已有活动 run，直接恢复，不启动第二个。
- 关闭面板不取消正在进行的 intake run；重新打开读取 snapshot 并恢复。用户主动取消时走现有 run cancel 语义。

### 5. 浮窗卡片：后置且不绑定 XML

本轮不实现卡片、不新增 `SurfaceSpec`、不新增 `interview.profile.patch` 表单。

未来若需要卡片，它只是某条 intake 问题的可选呈现方式：

- 卡片内容由 Agent 的提问意图决定，可以是确认、单选、补充一段经历或填写项目信息，不要求与 `profile.xml` 字段一一对应。
- 用户提交后仍作为普通 user message 回到 intake 对话，由 intake Agent 决定如何写画像；renderer 不直接写 `profile.xml`。
- 卡片不是画像事实源，也不替代 `profile.xml`；没有卡片时纯文本对话必须完整可用。

### 6. 明确不做

- 不做 `building / ready / failed` 制作状态、制作进度条或后台构建队列。
- 不做候选人实战回答、系统声音采集、远程仓库 clone、安装依赖或执行项目命令。
- 不做 XML parser、结构化表单或卡片字段映射。
- 不让 renderer 直接调用 Agent、创建任意 conversation 或传 prompt/工具。
- 不把 intake 和音频/演练 transcript 混在同一个 conversation。

## 影响表面

- **用户行为**：引导完成或跳过后立即进入面试分身对话；AI 主动读资料并开始补画像，缺信息时在对话里问；不再停在静态“制作中”卡片。
- **UI**：`InterviewAvatarPanel` 从入口移除，`InterviewIntakePanel` 使用现有对话原语；不新增制作状态或进度。无资料、资料读取失败、跳过引导都有明确的对话入口。
- **进程/协议**：renderer → preload → main IPC → Agent worker 的显式 intake 命令；main 校验 window sender 和固定 conversation ID；Agent 进程执行工具，desktop 不代执行。新增 intake snapshot/events 读取，避免误用 conversation runtime。
- **持久化**：`profile.xml` 由 intake 维护；`wizard.json` 只保存引导输入；不新增制作状态文件。intake transcript 与音频/演练分开，关闭应用后的持久化沿用现有 conversation store 能力。
- **权限/隐私**：只有 intake 有 `workspace.edit`；演练官只读。简历、项目正文和画像正文不写日志、浮窗状态或审计；系统上下文中的绝对路径不展示给用户。
- **测试**：新增 UI 入口/对话状态测试、open 幂等测试、intake prompt/工具授权测试、IPC sender/ID 校验测试、snapshot/events 域隔离测试；更新演练官工具测试。

## 曾考虑的替代方案

- **后台制作任务：`building / ready / failed` + 进度条：** 舍弃。既有提案没有这个状态机，用户也没有要求；一次 intake 对话已经能表达“AI 正在读、正在问、已写入”，额外状态会制造假进度和恢复问题。
- **保留 `InterviewAvatarPanel`，只加一个“开始制作”按钮：** 舍弃。点击后仍需要对话和 Agent 读写；静态卡片不能承载追问、纠错和用户补充，最后还是会变成聊天页。
- **复用演练官作为 intake：** 舍弃。演练官的身份是面试官，prompt、提问方式和工具权限都不同；让同一个 Agent 既提问又写画像会角色串台，也会保留两个画像写入口。
- **用一条可见的“开始准备”user message 触发开场：** 舍弃。它会永久留在 transcript，让用户以为是自己说的话，也会污染后续上下文；优先使用模型侧 开场输入，只落 assistant 消息。
- **把卡片直接映射 `profile.xml` 字段：** 舍弃。用户情况无法穷举，固定字段会限制追问；卡片只做可选输入界面，事实仍由 intake 写进自由文本 `<memory>`。
- **复用 conversation runtime 的 `guided-intake` profile：** 暂不采用。当前面试已有独立 application、画像路径和音频 runtime；把 intake 放进 conversation 域会分散画像写入和 transcript 边界。等通用 intake 成为跨场景能力再提升。
- **intake 和音频共用 `active-interview-conversation`：** 舍弃。会把资料整理对话和面试/演练内容混在一起，后续候选人实战无法可靠区分上下文。
- **让 intake 直接 clone 远程项目：** 暂缓。clone 涉及网络、磁盘、凭据和不可信代码执行，不能藏在“读项目”里；本轮只记录 URL，需要时让用户给本地路径。

## 验收标准

- 引导 `completed` / `skipped` 后打开面试面板，直接出现 intake 对话页；页面上没有“制作中”“制作进度”“制作能力接入中”。
- 空 intake conversation 首次打开只启动一次开场 run，transcript 只出现 assistant 开场，不出现伪造的 user 消息；再次打开不重复开场。
- 有简历/项目时，AI 能读到资料并把确认事实写入 `profile.xml` 的 `<memory>`，更新 `updated`/`<history>`；缺信息时一次问一个问题。
- 跳过引导或无资料时，AI 先问目标岗位/简历/项目，不声称画像已完成；用户补充后继续写入。
- intake 是唯一画像写入者；演练官工具清单不含 `workspace.edit` / `workspace.run-command`，prompt 不再要求维护画像。
- intake 的 snapshot/events 来自 interview 域，不误读 conversation runtime；intake 与音频/演练 conversation 不互通。
- 开场/回复失败表现为普通 run 错误，用户可继续输入或重试；不存在独立的制作成功/失败状态。
- 自动化：UI 入口与对话状态、open 幂等、prompt/tool 授权、IPC sender/ID 校验、snapshot/events 域隔离测试通过；`pnpm verify`、`pnpm notes:check` 通过。
- 实机待执行：用真实 PDF/DOCX 简历和本地项目路径打开页面，确认 AI 能读取、写画像、问第一个问题；确认用户看不到 XML 原文和绝对路径；记录 Windows 版本与结果。

## 验证

- `pnpm verify` 通过：lint、全包 typecheck、`db:check`、全量 vitest、release profile、架构与 token 检查。最终重复运行时，既有 `apps/agent/test/core/tool/shell/shellTools.test.ts` 进程树超时用例在并行负载下偶发超时，单独重跑通过，与本改动无关。
- 新增/更新测试：`apps/agent/test/interview/agent.test.ts`（intake 开场只进模型请求、intake 工具与演练只读工具）、`apps/agent/test/interview/application.test.ts`（无 user 消息开场、二次打开不重复）、`apps/desktop/test/interviewIpc.test.ts`（intake 四个 IPC 频道的 sender 与载荷）、`packages/ui/test/InterviewOnboardingPanel.test.tsx`（完成/跳过直接进入对话、无资料也进入、资料入口）。
- 修正 `packages/shared/test/schema.test.ts` 的旧事件计数：共享 schema 已新增 `context-usage-changed`，但测试仍按 4 个执行事件断言；本次补上该事件并把总数改为 5/33/29，使全量测试恢复。
- 未执行：真实 PDF/DOCX、真实项目路径与 Windows 实机验收；需要模型端点和真实资料才能验证 AI 的读取与画像写入质量。

## 后果与防回退

- **开场 run 依赖无 user 消息的启动能力**：如果现有 store/executor 要求至少一条 user 消息，需要扩展领域开场输入或明确标记；不能退化成伪造用户消息。已用测试证明 `beginOpeningRun` 只落 assistant 占位。
- **AI 写坏 XML**：本轮不引入 parser/结构化 patch，依赖 prompt 和 `workspace.edit`；复杂简历或模型偏差可能产生非法 XML。需要后续实测决定是否引入领域校验工具，不能把“文件存在”当成画像有效。
- **长资料读取慢**：PDF、项目源码和多次工具调用会让首个回复变慢；不新增进度或阶段。用户关闭页面不应取消 run，重新打开恢复。
- **intake 问得过多**：可能重复追问或把对话变成审讯；prompt 限制一次一个问题，用户可随时结束或只给部分信息，画像允许待确认项。
- **两个写入口回退**：如果演练官仍保留 `workspace.edit`，画像会被两个 Agent 修改；本实现要求同时收缩演练官工具，测试必须覆盖。
- **远程项目预期**：用户可能以为 AI 会自动 clone URL；本轮明确只记录 URL，需要时请用户提供本地路径，避免网络、磁盘和执行风险。
- **隐私泄露**：简历/项目正文和绝对路径进入模型上下文，prompt 要求不展示、不写日志；仍需在实测中检查错误消息、工具输出和 UI 是否泄露路径或正文。
