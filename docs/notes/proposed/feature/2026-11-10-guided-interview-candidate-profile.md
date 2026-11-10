# Note：面试引导式候选人画像与演练副驾驶

状态：提案

## 问题

当前面试能力可以采集语音、转录面试轮次并生成回答建议，但 Agent 不知道候选人的真实经历、代码贡献、项目结果和表达边界。若要求用户自行整理资料、编写 prompt 或主动告诉 AI 应该读取什么，首次使用成本高，也不能形成稳定的候选人上下文。

面试的产品角色也不是“用户提问、AI 回答”的普通聊天，而是 AI 与用户同时参加面试：AI 观察面试官的问题，代表用户从真实经历中组织回答参考；在正式面试前，AI 需要主动引导用户接入资料、追问事实并通过面试演练补全画像。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/candidate-context/`、`apps/agent/src/interview/` 的面试模式编排、`apps/agent/src/interview/reply/`、`apps/agent/src/interview/runtime.ts`、worker 面试命令与事件投影、`packages/shared` 面试展示 DTO、`packages/ui` 面试空白态和画像确认视图、`apps/desktop` 工作区授权上下文。
- UI/进程/协议/持久化表面：面试空白对话区增加预置的“开始建立我的面试画像”触发按钮；Agent 负责主动提问、资料发现、事实提取、演练和检索；Renderer 只展示引导问题、授权请求、事实确认和回答建议。候选人画像需要跨面试会话保留，但当前实现可先使用 Agent 进程内存适配器，持久化后端由统一 storage backend 选择，不按领域各建数据库。
- 相关 Note：[产品方向与 Agent 底座](../architecture/2026-10-20-product-direction-and-agent-foundation.md)、[面试语音运行时模块边界与并行开发契约](../architecture/2026-10-19-interview-runtime-module-boundaries.md)、[面试模式持续监听与回答建议](2026-10-12-live-interview-assistant.md)、[可切换的内存与 SQLite 存储边界](../architecture/2026-11-08-switchable-memory-sqlite-storage.md)、[Conversation 领域目录按会话与回合组织](../../implemented/architecture/2026-11-06-conversation-domain-layout.md)。

## 提案

### 产品流程

面试空白对话区提供一个 Agent 预置入口“开始建立我的面试画像”。该入口只发送稳定的领域命令，不允许 Renderer 注入 prompt、工具或画像规则。触发后由 Agent 接管流程，按当前状态主动推进：

1. **了解目标**：询问目标岗位、公司、面试类型和时间；用户可以跳过，Agent 仍可继续建立基础画像。
2. **发现资料**：逐步询问“简历在哪里”“项目代码或作品集在哪里”“是否有技术博客、绩效或项目文档”。每次只提出一个下一步问题。需要读取文件时，Agent 发出结构化的工作区授权请求，Desktop 负责让用户选择文件或目录并只回传获准的根路径/文件清单。
3. **提取草稿**：Agent 使用静态注册且有权限边界的文件读取工具分析获准资料，生成带来源的候选人事实草稿，不把原文全文写入画像。事实必须标记来源、可信度和是否已经由用户确认。
4. **主动追问**：根据资料中的信息缺口选择下一个高价值问题，例如个人贡献、困难、结果、验证方式和团队边界。用户的回答进入候选人上下文，Agent 可继续追问，但每轮只推进一个明确问题。
5. **确认画像**：Agent 将重要事实、项目证据、可讲述故事和表达偏好分批展示为“待确认”。用户可以确认、修改、删除、标记“面试中避免提及”，未确认事实不能以确定语气进入回答。
6. **主动建议演练**：画像达到最小可用条件，或用户明确表示暂时没有更多资料时，Agent 询问是否进行面试演练。用户同意后，Agent 作为面试官提问，用户通过文字或麦克风回答；Agent 评价回答与画像的一致性、证据充分性和追问风险，并把修正后的事实或故事再次提交确认。
7. **进入正式面试**：用户启动实时面试后，系统继续监听面试官问题，同时检索已确认的候选人上下文生成回答参考。正式面试不自动修改确认事实；新的推断或纠正进入待确认队列，避免一次回答污染后续画像。

Agent 应主动推进上述状态，不要求用户理解内部命令或手工编写提示词。用户可以跳过、暂停、停止或清空画像；这些是显式领域操作，不由模型自由解释为状态转换。建档、演练和正式面试均由同一个 Interview Agent 负责，只通过显式的 `mode` 区分行为：`profile-building`、`rehearsal`、`live`。模式切换由领域命令驱动，不能通过会话 ID 推断，也不能创建第二个 Agent 或第二份候选人画像。

### 候选人上下文模型

画像不是一段不可审计的摘要，而是由可追溯事实组成：

```ts
type CandidateFact = {
  id: string;
  category: "profile" | "experience" | "project" | "skill" | "achievement" | "story" | "preference" | "constraint";
  statement: string;
  details?: Record<string, string>;
  sources: Array<{ type: "resume" | "code" | "document" | "user-answer" | "rehearsal-correction"; path?: string; location?: string }>;
  confidence: "low" | "medium" | "high";
  confirmation: "unreviewed" | "confirmed" | "rejected";
  interviewVisibility: "allowed" | "avoid" | "private";
  revision: number;
};
```

画像至少包含四类投影：基础事实、项目/代码证据、可复用的 STAR 故事、表达与披露偏好。事实、来源和确认状态是事实来源；摘要、embedding 或回答卡片都只能是可重建的查询投影，不能成为第二事实来源。

### 正式面试中的回答副驾驶

同一个 Interview Agent 在 `live` 模式下的回答 workflow 只接收稳定的 `InterviewerTurn` 和候选人上下文检索结果，不直接读取文件、不解析供应商事件。每次建议包含：

- 建议回答方向或草稿；
- 可引用的已确认事实和来源证据；
- 候选人的真实贡献边界；
- 未确认、缺少证据或不应披露的内容；
- 可能的面试官追问。

模型不得补造项目数据、代码贡献、职位职责或量化成果。没有确认的事实只能以“需要确认/可作为假设”显示，不能伪装成候选人的确定经历。AI 只在 Answra 浮层提供参考，不自动向会议软件发声或发送答案。

### 领域与模块边界

```text
interview/
  candidate-context/
    contracts.ts          事实、来源、确认和授权端口
    application.ts        建档/追问/确认用例编排
    factStore.ts          候选人事实端口与当前适配器
    sourceDiscovery.ts    下一资料问题和授权请求
    contextRetriever.ts   面试问题到已确认事实的检索
  modes.ts                 同一 Interview Agent 的显式模式与模式策略
  application.ts           建档、演练、正式面试的用例编排
  reply/
    profile.ts            正式面试回答 profile
    loop.ts               可取消回答 run；只消费 turn/context
```

`interview/runtime.ts` 继续作为组合根，只连接面试音频、turn、候选人上下文和模式用例，不承载资料扫描、画像规则或模型 prompt。面试只有一个静态注册的 Interview Agent；模式策略决定当前允许的工具、上下文和输出类型：建档模式可以请求资料授权和追问，演练模式可以提出模拟面试问题并评价回答，正式模式只读已确认画像并生成回答建议。文件读取工具在 Agent 进程静态注册并由当前模式 profile 授权；Desktop 只负责用户选择、路径边界和授权上下文，不代执行 Agent 工具。候选人上下文先属于 `interview`，不提前创建跨领域 `core/memory`；等第二个真实领域复用相同事实机制后再抽取共享端口。

### Worker、UI 与存储

- 新增显式命令子类型，例如 `interview-profile-start`、`interview-profile-answer`、`interview-profile-confirm`、`interview-rehearsal-start` 和 `interview-profile-stop`；命令只携带稳定字段，不携带任意 prompt、工具实现或文件绝对路径。
- 新增面试事件投影，例如 `profile-question`、`source-permission-request`、`fact-review-required`、`rehearsal-question` 和 `profile-progress`。Agent 内部事件先在 `workerProjection` 转为 DTO，`packages/shared` 只定义 Renderer 必需的展示形状。
- UI 空白态显示预置入口；建档态显示单问题引导、授权请求、进度和事实确认；演练态复用面试对话流但明确标记为 rehearsal；正式面试态继续使用现有监听、转录和回答建议表面。
- 画像存储通过独立 `CandidateContextStore` 端口注入。第一阶段可用内存实现验证流程；需要跨应用重启时，由统一 storage backend 提供 SQLite adapter，并与 transcript/execution 使用同一数据库定位和事务规则。不能在 UI 或模型消息中伪造持久化成功。

## 影响表面

- **用户体验**：面试空白态拥有主动建档入口；AI 负责逐步询问资料位置、读取授权资料、追问事实、邀请演练并在正式面试中提供有证据的回答参考。
- **Agent**：保留一个 Interview Agent，新增候选人上下文和显式模式编排；正式回答 workflow 增加只读上下文检索；文件工具、模型执行、run 取消和事件写入沿用现有底座。
- **Desktop/IPC**：增加类型化资料授权和画像/演练命令转发；校验发送窗口和工作区路径，preload 只桥接。
- **Shared/UI**：增加画像进度、问题、授权请求、事实确认和演练状态 DTO；packages/ui 增加空白态、引导态和确认态行为测试。
- **存储与隐私**：画像默认由用户可见、可修改、可删除；原始文件不等于画像事实，未经授权的路径不读取；云端模型只收到当前 profile 允许的最小上下文。

## 曾考虑的替代方案

- **让用户在输入框中自己告诉 AI 简历和代码在哪里：** 舍弃。它把产品理解成本转嫁给用户，无法保证授权边界、资料发现顺序和画像完整性；改为预置领域命令触发、Agent 主动单问单答。
- **为建档、演练和正式面试分别创建 Agent：** 舍弃。三者共享同一个候选人上下文、面试目标和权限边界，拆成多个 Agent 会造成状态同步、人格漂移和工具授权重复；采用一个 Interview Agent 加显式模式策略。
- **开始面试时自动扫描整个用户电脑：** 舍弃。路径范围、隐私和误读风险不可接受；只允许用户逐项选择文件/目录并由 Desktop 返回授权上下文。
- **把候选人画像做成全局 `core/memory`，供所有能力域共享：** 暂缓。当前只有面试有明确的候选人事实语义，过早抽象会把面试策略泄漏到共享底座；第二个真实消费者出现后再抽取机制。
- **只保存一段自动生成的用户摘要：** 舍弃。摘要无法表达来源、确认、披露边界和版本，也无法支撑用户纠错；采用结构化事实加可重建投影。
- **正式面试中边回答边自动覆盖画像：** 舍弃。实时转录可能有误，回答推断也可能被误认为事实；正式面试只生成待确认变更，用户确认后才更新画像。
- **用向量数据库作为第一版记忆核心：** 暂缓。第一版的主要难点是引导、授权、确认和事实边界，先用结构化字段、分类和有界关键词/语义检索验证行为，再按真实数据量评估 embedding。

## 验收标准

- 可观察结果：空白面试区可点击预置入口；Agent 会主动询问目标、简历、代码/作品集位置，并在每次只提出一个下一步问题；资料授权、跳过、暂停、停止和清空均有明确状态。
- 可观察结果：授权资料生成带来源的事实草稿；未确认事实显示为待确认；用户可确认、修改、删除和设置面试可见性；画像进度可见。
- 可观察结果：画像达到最小条件后 Agent 主动询问是否演练；演练回答可产生反馈和待确认修正；正式面试回答能展示相关已确认证据、贡献边界和追问提示。
- 安全边界：Agent 不读取未授权路径；Renderer 不注入任意 prompt/工具；未确认事实、敏感事实和标记为 avoid/private 的事实不以确定语气进入正式回答；不自动向会议软件发送或发声。
- 自动化验证：单个 Interview Agent 覆盖模式状态机、单问题推进、跳过/暂停/恢复、事实版本与确认、来源绑定、检索过滤、建档/演练/正式面试的模式隔离、过期 run 丢弃和停止清理；worker/IPC 覆盖发送者校验与 DTO 投影；UI 在 `packages/ui/test/` 覆盖空白态和确认交互。
- 自动化验证：`pnpm notes:check`、`pnpm verify`、架构检查和 `git diff --check` 通过；测试不得把 mock 的“扫描成功”当作 Windows 文件授权实测。
- 需要的实机验证：Windows 下选择 PDF/DOCX/代码目录的授权流程、超大仓库/无权限目录、中文路径、面试演练和真实会议音频下的回答延迟与停止清理。未完成实机验证前，不宣称资料接入和正式面试可用。

## 风险

- 简历或代码可能含有密码、密钥、客户资料和第三方隐私；文件读取工具必须有路径白名单、敏感文件排除和有界结果，上传云端前需要明确的服务商数据处理提示。
- 代码中的作者归属和项目结果通常不能仅由静态分析证明；Agent 必须把代码分析当作证据候选，要求用户确认个人贡献，不得把提交记录或目录名称当作事实。
- 主动追问过多会打断用户；需要每轮一个问题、可跳过、可暂停，并设置最小画像完成条件，避免无限建档。
- 画像跨面试保留会增加隐私和删除复杂度；第一版必须提供显式查看、清空和按事实删除，存储后端切换不能改变这些语义。
- 正式面试的实时转录、模型延迟和回答错误可能影响用户判断；回答建议必须标记为参考，保留取消和停止控制，不自动代替用户发言。
