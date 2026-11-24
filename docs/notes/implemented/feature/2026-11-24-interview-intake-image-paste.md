# Note：面试分身支持粘贴图片

状态：已实施

## 问题

面试分身的资料 intake 对话只有文本输入。用户手里的材料经常是简历截图、项目界面截图或聊天记录截图，无法直接贴进对话，只能先保存成文件再描述。主对话（AI 对话、回复条）早已支持粘贴图片并作为视觉输入，但 intake 面板显式传了 `showAttachments={false}`，下层 `sendInterviewIntakeMessage(text)` 也只接收文本；`InterviewApplication.sendText` 固定写入 `images: []`，整条链路都没有图片位置。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/channels/conversation.ts`：新增 `ConversationImage`，`ConversationSendRequest.images` 复用它。
  - `packages/shared/src/channels/interview.ts`、`bridge.ts`：`IntakeMessage` 载荷与 `sendInterviewIntakeMessage(text, images)` 增加图片。
  - `apps/desktop/src/preload/index.ts`：转发 `{ text, images }`。
  - `apps/desktop/src/main/agent/conversationImages.ts`：新增 `parseConversationImages`，集中图片数量/大小/媒体类型校验。
  - `apps/desktop/src/main/agent/agentService.ts`：`sendInterviewIntakeMessage` 带上图片；`validateSendRequest` 复用同一校验。
  - `apps/desktop/src/main/interview/interviewIpc.ts`：解析并校验 intake 图片载荷，允许“只发图片”。
  - `apps/agent/src/worker/protocol.ts`、`host.ts`：`interview-intake-message` 命令携带 `images`，路由到 `sendMessage`。
  - `apps/agent/src/interview/application.ts`：新增 `sendMessage`，把文本与图片写成同一条 user 消息；`sendText` 保持只发文本。
  - `apps/agent/src/core/model/requestContent.ts`：`validateModelRequest` 接受 `readonly` 图片数组，供 intake 复用。
  - `packages/ui/src/app/attachments.ts`：新增附件创建、释放与转图片载荷的共享实现。
  - `packages/ui/src/app/useConversationChat.ts`、`useReplyWorkflow.ts`：改用共享附件实现，行为不变。
  - `packages/ui/src/interview/intake/useInterviewIntake.ts`：维护附件状态、发送图片、关闭面板释放 blob URL。
  - `packages/ui/src/interview/intake/InterviewIntakePanel.tsx`：启用附件预览、`+` 按钮与粘贴入口。
- 测试：`apps/agent/test/interview/application.test.ts`、`apps/desktop/test/interviewIpc.test.ts`、`apps/desktop/test/agentService.test.ts`、`packages/ui/test/InterviewIntakePanel.test.tsx`、`packages/ui/test/support/floatingBarHarness.ts`。
- UI/协议/持久化表面：新增 renderer → main → worker 的图片载荷；intake user 消息会像主对话一样持久化 data URL；不新增文件落盘。

## 影响表面

- 面试分身输入框出现 `+` 附件按钮，粘贴剪贴板图片会显示待发送预览，可删除后再发。
- 只发图片不写文字也可以发送；文本和图片作为同一条消息进入 transcript 与模型请求。
- 图片作为视觉输入，不写入 `profile.xml`；资料整理仍由 Agent 根据对话内容完成。
- 主对话与回复条的粘贴/预览行为不变，只把重复的附件转换抽到 `app/attachments.ts`。
- 边界限制：单条消息最多 8 张、单图 data URL ≤ 11.2 MB、仅 PNG/JPEG/WebP/GIF；一次粘贴仍只取剪贴板第一张图片，与主对话一致。

## 决定

- 图片作为 user 消息的 image part 直接发送，而不是先保存到面试资料目录再让 Agent 用工具读取：复用已存在的视觉输入链路，不需要新的文件命名、清理和工具授权；截图本来也不是可直接检索的文本事实。
- 复用 `ChatPanel` 的附件 UI 与 `ConversationImage` 契约，不为 intake 另立图片协议。
- intake 与演练共用 `InterviewApplication`：新增 `sendMessage` 承载文本+图片，`sendText` 继续只发文本，演练路径的协议与行为不变。
- 附件转换抽到 `packages/ui/src/app/attachments.ts`：现在有发送主对话、回复条和 intake 三个消费者，避免第三份 `fetch` + `FileReader` 实现。
- 图片规则只在 desktop main 的 `parseConversationImages` 定义一次，主对话与 intake 共用；Agent 侧 `validateModelRequest` 继续校验媒体类型与解码后 8 MB 上限，形成两道边界。

## 曾考虑的替代方案

- **只加 UI 预览、不真正发送**：界面看起来支持但模型收不到图片，属于假功能。
- **图片先存进 interview 数据目录，再让 intake Agent 读取**：需要额外的命名、生命周期清理和工具授权，且 prompt 不保证会读；还会把一次视觉输入拆成消息与文件两个真相源。
- **只允许“图片 + 文字”，不允许只发图片**：截图场景下文本往往为空，强行要求文字没有产品价值。
- **在 intake 单独维护一套图片校验**：与主对话规则漂移，后续改上限必然漏改一处。
- **OCR 成文字再发送**：引入新依赖与第二真相源，表格和排版类截图识别不可靠，且丢失原始视觉信息。

## 后果与防回退

- intake user 消息会持久化图片 data URL，和主对话一样占用会话存储；超大截图受 11.2 MB data URL 上限约束。
- intake 模型必须支持视觉输入；不支持时由 provider 报错并在面板显示，不做静默丢图。
- `ChatPanel` 的粘贴入口仍只取 `files[0]`；将来要支持一次粘贴多张，应改 `ChatPanel` 的附件入口，而不是在 intake 另写一套。
- `parseConversationImages` 是主对话与 intake 的唯一图片校验入口；新增发送路径必须复用，不得复制正则与上限。
- `InterviewChannelMap[IntakeMessage].request`、preload 与 `DesktopBridge.sendInterviewIntakeMessage` 三处签名必须同步；worker 协议 `interview-intake-message` 的 `images` 是唯一跨进程载荷。
- 图片只影响当轮 user 消息；`profile.xml` 的写入规则仍只由 intake Agent 决定，不能因为支持图片就默认可从截图自动更新画像。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/interview`：86 项通过，覆盖 intake 图片落账与非法媒体类型拒绝。
- `pnpm --filter @answra/desktop exec vitest run`：380 项通过，覆盖 IPC 转发图片、拒绝 BMP、空文本空图片，以及 AgentService 转发到 worker。
- `pnpm --filter @answra/ui exec vitest run`：361 项通过，新增 `InterviewIntakePanel.test.tsx` 覆盖粘贴预览并随文本发送、仅图片发送、非图片忽略。
- `pnpm --filter @answra/shared typecheck`、`@answra/ui`、`@answra/agent`、`@answra/desktop` typecheck 通过；`pnpm lint`、`pnpm architecture:check`、`git diff --check` 通过。
- 实机验证（人工）：在面试分身输入框粘贴简历截图，确认预览、发送后模型能引用图片内容；使用不支持视觉的模型时应显示 provider 错误而不是吞掉图片。
