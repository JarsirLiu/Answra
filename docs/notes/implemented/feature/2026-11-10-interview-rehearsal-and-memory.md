# Note：面试演练与面试记忆

状态：已实施

## 问题

现有面试能力能采集麦克风、转录候选人语音并生成通用回答建议，但 Agent 不知道候选人的真实简历、项目贡献和表达边界。用户说“讲一个你的项目”“这个指标怎么来的”时，回答容易空泛，也无法保证不编造经历。

用户要的是**一个面试 bot**，不是多个 bot，也不是严格的建档流程。当前先交付演练模式：bot 可以按需读取简历和项目资料，陪用户动态演练，并把用户确认的信息写入面试记忆。正式面试模式（听系统声音、作为候选人替身实时给参考）后续再做。

## 涉及范围

- Agent 领域：`apps/agent/src/interview/`。演练提示词与记忆路径在 `rehearsal/profile.ts`；Agent 组装在 `agent.ts`；文本/语音共用的回复入口在 `application.ts`；命令路由在 `host.ts`。
- 通用能力：`apps/agent/src/core/agent/toolStepLimit.ts` 从 conversation 上提，供对话与演练共用。
- 线协议：`apps/agent/src/worker/protocol.ts` 新增 `interview-context` 和 `interview-message`。
- Desktop：`apps/desktop/src/main/agent/` 是跨领域 Agent worker 客户端；`interviewIpc.ts` 新增 `InterviewChannels.Message`；`preload` 暴露 `sendInterviewMessage`。
- Shared/UI：`packages/shared/src/channels/interview.ts`、`packages/shared/src/bridge.ts`；`InterviewFeaturePanel` 接管演练面板状态，`FloatingBarApp` 只保留装配。
- 相关 Note：[面试语音运行时模块边界](../../proposed/architecture/2026-10-19-interview-runtime-module-boundaries.md)、[面试模式持续监听与回答建议](../../proposed/feature/2026-10-12-live-interview-assistant.md)、[领域 Agent 模块注册](../../proposed/architecture/2026-11-07-domain-agent-module-registration.md)、[工作区是默认根而不是边界](../architecture/2026-11-09-workspace-default-root-not-boundary.md)、[Read 文档文本抽取](2026-11-10-read-tool-document-text.md)。

## 影响表面

- 用户进入“面试演练”，可以直接输入文字，也可以打开麦克风说；两种输入都进入同一份会话和同一个 Agent。
- 空白消息区提供“开始面试演练”按钮；点击等价于代替用户发送固定消息“开始面试演练。请先检查我的面试记忆和简历是否存在，再引导我补充信息；资料齐全后再开始提问。”，仍走 `interview-message`，不新增启动命令或状态机。
- 演练 Agent 获得 `Read`、`Grep`、`Edit` 和通用 Shell。它先读资料再提问，不自动把记忆、简历摘要或项目总结塞进 prompt。
- 面试记忆固定为 `appData/Answra/interview/profile.md`（Windows 为 `%APPDATA%\Answra\interview\profile.md`），由 Agent 用通用文件工具读写；不新增专用 store、写文档工具或 JSON schema。
- system prompt 只带记忆路径、工作区上下文和读取规则；资料内容按需读取。
- 文字发送通过 `answra:interview:message` 到 worker，先追加 user 消息，再启动模型回复；麦克风路径仍走原有 turn 结算。
- 本轮不实现系统声音采集、音频来源切换和面试模式；desktop 仍只采集用户麦克风。

## 决定

- 只有一个面试 bot，一个 conversation，一份 `profile.md`。没有 `botId`、bot 选择器、coach、bot 互相召唤，也没有 `interview-profile-start` / `interview-profile-confirm` 阶段命令。
- 记忆是 Markdown，不是应用解析的数据库。文档记录：目标岗位、简历摘要、简历路径、项目总结、项目地址、经历证据、披露边界、待确认、上次修改时间和记忆变更记录。
- 写入只发生在演练模式，且只写 `interviewDataRoot` 下的记忆文件；不改用户工作区。面试模式以后只读。
- `interviewDataRoot` 由 desktop 固定为 `appData/Answra/interview`，不跟随 Electron 的 `userData` 目录名；开发态 package name 是 `@answra/desktop`，用户记忆不能落在 `@answra` 下。
- 演练提示要求一次只问一个关键问题，回答后先给一句简短反馈再追问；不套固定题库，不编造项目、指标、职责或技术细节。
- 每次写入更新顶部“上次修改”并追加一条“记忆变更记录”；文件 mtime 作为外部校验。
- 工作区是默认查找位置，不是访问边界；找不到资料时直接问用户路径，只有用户明确要求才做全盘扫描。当前没有新增 `workspace.find`，需要发现文件时用 `Grep`/Shell。
- 文字和语音共用同一 Agent 与同一回复状态机；文字输入不再只追加消息，而是启动回复。
- `AgentService` 与 `AgentWorkerProcess` 从 `main/conversation/` 移到 `main/agent/`，因为它们同时服务 conversation、answer 和 interview，放在对话目录会误导领域归属。
- 删除未被引用的旧 `interview/reply/profile.ts`，避免与 `rehearsal/profile.ts` 形成两份面试提示词。

## 曾考虑的替代方案

- **严格建档/画像/演练阶段：** 舍弃。用户不需要阶段状态机；记忆可以随时补充和修改。
- **多个 bot 分别做面试官、候选人替身、教练：** 舍弃。归属、上下文同步和“谁接替谁”都会增加复杂度，用户只需要一个 bot。
- **独立复盘教练 bot：** 舍弃。演练中需要点评时由同一个 bot 简短反馈即可。
- **每轮自动注入画像、简历摘要和项目总结：** 舍弃。持续消耗上下文、放大隐私暴露，还容易读到旧副本；只给路径，按需读取。
- **专用 `FileStore` / `MemoryStore` / `profile.writeDoc`：** 舍弃。Agent 已能用通用文件工具读写私有目录，再加领域存储会把写入权复制成第二套实现。
- **把记忆做成全局 `core/memory`：** 暂缓。目前只有面试有这份记忆语义；第二个真实消费者出现后再抽象。
- **把记忆写进用户工作区：** 舍弃。隐私边界错误，工作区切换、Git 同步和用户手改都会破坏记忆语义。
- **文字发送只追加消息、不启动回复：** 舍弃。演练需要 bot 继续提问或点评，只追加会让输入没有反馈。
- **把面试面板状态继续留在 `FloatingBarApp`：** 舍弃。根组件已经承担导航、模式、回复流和设置；演练会话投影、发送失败和清空属于面试领域，应单独放置。

## 后果与防回退

- 正面后果：演练可以基于真实资料追问，不再只依赖本轮对话；用户能检查一份可读、可手改、带修改时间的记忆。
- 代价：模型是否读取资料仍取决于自身判断；prompt 只能要求“先读再答”，不能保证每次执行。记忆格式也没有 application 级校验。
- 防回退：
  - 不得新增第二个面试 bot、bot 选择器或阶段状态机。
  - 不得把 `profile.md` 全文、简历摘要或项目总结自动拼进每轮 prompt；只允许路径和读取规则。
  - 不得在面试模式（未来的系统声音来源）授权 `Edit` 或 Shell，也不得写记忆。
  - 不得让桌面端代执行 Agent 工具；desktop 只注入工作区/记忆根。
  - 不得把 `AgentService` 移回 conversation 目录；它不属于单一对话域。
  - 文字发送必须继续走 `interview-message` 并启动回复，不能退化为纯追加。
  - 演练面板状态应留在 `InterviewFeaturePanel`，不要重新堆回 `FloatingBarApp`。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm --filter @answra/ui typecheck`：通过。
- `pnpm --filter @answra/agent exec vitest run test/interview/agent.test.ts test/interview/application.test.ts test/core/agent/toolStepLimit.test.ts`：通过；覆盖记忆路径存在但内容不注入、无私有根时的降级提示、文字发送走同一回复路径。
- `pnpm --filter @answra/desktop exec vitest run test/agentService.test.ts test/interviewIpc.test.ts`：通过；覆盖 `InterviewChannels.Message` 转发与 `AgentService` 重连。
- `pnpm --filter @answra/ui exec vitest run test/InterviewCapturePanel.test.tsx test/FloatingBarApp.interview.test.tsx`：通过；覆盖演练文案、文字发送、失败保留草稿、清空和断线清理。
- `pnpm exec biome check`（本次改动文件）：通过。
- 尚未实机验证：真实模型是否按提示主动读取简历、PDF/DOCX 中文路径、记忆写入后的 mtime 与变更记录、Windows 系统声音采集。未完成前不宣称面试模式可用。
