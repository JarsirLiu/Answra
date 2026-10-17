# Note：对话与答题 AI 领域拆分及对话能力复用

状态：已实施

## 问题

当前“对话”和“答题”已使用不同会话 ID，但仍共用 `useConversationChat`、`ConversationSendRequest`、IPC 命令和 `ConversationRuntime`。Agent 通过比较特殊会话 ID 决定使用哪份提示词及上下文策略；除通用对话外，其他未知 ID 都会落到答题行为。这是约定式隔离，新增场景容易修改同一组核心文件。

此外，答题请求目前也进入通用会话存储。它虽只把本轮输入交给模型，旧消息和截图仍会留在内存会话中。后续应让“单轮答题”拥有明确的无历史与清理生命周期。

通用对话未来会被笔记、资料问答等其他功能复用，但不同场景可能需要不同提示词、工具和上下文策略。若把这些差异写进一个不断增长的 `ConversationRuntime` 条件分支，或允许 renderer 任意传入提示词/工具定义，都会模糊 Agent 的能力边界。

## 涉及范围

- 代码/模块：`packages/ui`、`packages/shared`、`apps/agent/src`、`apps/desktop/src/main/conversation`
- UI/进程/协议/持久化表面：通用对话与截图答题的请求入口、Agent 命令、上下文/工具选择、会话和运行事件生命周期；模型连接配置和主进程凭证存储继续共享。
- 相关 Note：[对话模式与答题模式分离](../../implemented/feature/2026-10-17-separate-chat-and-exam-modes.md)、[后端拥有会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)、[截图答题使用一次性会话](../../implemented/architecture/2026-10-13-screenshot-ephemeral-conversations.md)、[Agent 组装点收归自身并抽象宿主传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)。

## 决定

把“对话会话”和“单轮截图答题”作为显式不同的 Agent 操作，底层共享模型执行与标准流式事件，不共享业务上下文：

- **通用对话能力**拥有会话 transcript、历史选择和多轮运行，可由对话面板及后续功能调用。调用方通过受控的 `profileId` 选择 Agent 内注册的场景定义；当前 `general-chat` profile 固定 system prompt 和历史上下文策略，不允许 renderer 传入 prompt 或工具实现。
- **截图答题能力**接收本轮文字与截图，使用答题专用 prompt，不读取任何对话 transcript。答题输入、图片与运行记录仅保留在本轮流式运行期间，运行结束或取消后清空；固定会话仅保留递增 revision，避免下一轮事件游标倒退。
- **共享模型执行器**负责模型 provider、共享安全校验、取消、流式 chunk 与通用错误映射。Profile/用例决定本轮 prompt、工具和上下文，不让执行器判断产品模式。
- Agent profile 由 Agent 代码注册和授权。renderer 只能发送受类型约束的 profile/task 标识与用户输入，不能传任意 system prompt 或可执行工具对象。
- Desktop 继续持有模型连接配置及密钥存储；不同用例共享配置读取与 provider 凭证，但会话数据、提示词、工具权限和运行生命周期按领域隔离。

当前代码按现有目录约定落地显式用例入口，尚未将模型执行器拆成独立目录：

```text
packages/shared/src/channels.ts  ChatSendCommand / AnswerRunCommand
apps/agent/src/worker/           显式命令分发
apps/agent/src/conversation/profiles.ts  Agent 注册的 profile 定义
apps/agent/src/conversation/runtime.ts   共用模型执行和运行生命周期
apps/agent/src/conversation/store.ts     会话存储与答题清理
packages/ui/src/app/             useGeneralChat / useScreenshotAnswer
```

共享协议显式区分 `chat.send` 与 `answer.run`，Agent host 映射到 `sendChat` 和 `runAnswer`，不再根据 `conversationId` 决定 prompt 或历史行为。两类操作复用标准 chunk/change 事件和 `runId`；UI 导出 `useGeneralChat` 与 `useScreenshotAnswer`，底层共用传输订阅与 chunk 校验实现。

Profile 采用 Agent 内静态注册表，不引入第三方插件加载、动态脚本或任意用户工具执行。当前只有 `general-chat`，包含 prompt 与 `includeHistory` 策略；新增场景需要由 Agent 显式登记并扩展 shared profile ID 联合类型。当前尚无工具调用能力，未来工具集必须由 profile/Agent 授权，不能从 renderer 注入。

## 模块边界

- `apps/agent/src/conversation/profiles.ts`：静态注册 profile 的 system prompt、历史策略和工具授权清单。当前工具清单为空，模型工具执行尚未接入。
- `apps/agent/src/conversation/runtime.ts`：通过独立公开方法处理 profile 对话与一次性答题；provider、取消和标准流式处理仍共享。答题在运行结束时清空 store 消息与 journal，保留 revision 单调性。
- `apps/agent/src/conversation/store.ts`：继续提供多轮对话存储；新增 `clear` 用于释放答题附件、消息和临时事件。
- `apps/agent/src/worker`：组合并分发显式类型化命令；保持现有 `AgentTransport` 宿主无关边界。
- `packages/shared`：只定义跨进程稳定的请求/响应与事件类型，不暴露 Agent 内部 prompt、工具实现或 store 结构。
- `apps/desktop/src/main/conversation`：继续拥有模型配置与密钥；只校验和路由类型化命令，不承载 prompt/context 规则。
- `packages/ui`：对话 UI 和答题工作流各自拥有草稿、附件及交互状态；低层 stream adapter 可以复用，但业务 hook 不以模式 ID 切换行为。

## 曾考虑的替代方案

- **仅把当前特殊会话 ID 判断替换成操作类型，仍然在同一个 Runtime/hook 执行：** 这是当前共享底层执行代码的实现方式，但 UI 已导出独立用例 hook，Agent 也有独立入口及答题清理策略。若 profile/answer 逻辑继续增长，应再抽取到平级模块，当前实现不应被当成最终的目录边界。
- **为对话、答题各复制一份 provider 和流处理代码：** 舍弃，因为错误映射、取消、图片校验和 chunk 透传会分叉；这些无场景差异的底层机制应共用。
- **第一阶段建设通用插件框架或允许 renderer 动态配置 prompt/tools：** 舍弃，因为当前只有通用对话和答题两个明确场景，动态加载与跨边界工具授权增加攻击面及维护成本；静态 Agent profile 足以支持后续扩展。
- **答题继续复用会话存储，只靠模型请求忽略历史：** 舍弃，因为旧截图和消息仍留在 worker 内存，数据生命周期与一次性答题的产品语义不符。
- **所有未来功能都复用同一个通用对话 profile：** 舍弃，因为特定功能的提示词、工具权限及上下文策略会污染其他消费者；共享对话引擎不代表共享同一行为配置。

## 验收标准

- 可观察结果：对话多轮历史和答题单轮上下文互不影响；答题运行结束或取消后，答题图片和临时事件从 Agent store 清理；未经登记的 profile 被拒绝。
- 自动化验证：Agent 测试覆盖命令路由、profile 授权、对话历史边界、答题不读取 transcript、答题结束清理、取消和共享 chunk；UI 测试覆盖两种操作发出的不同命令。
- 并行开发约束：新增 profile 不应修改答题 prompt/lifecycle；新增答题能力不应依赖 chat transcript。当前共享 runtime 文件是有意保留的过渡实现，后续复杂度上升时应抽取平级领域模块。
- 需要的实机验证：桌面端分别执行多轮对话和多次截图答题，验证取消、错误、关闭窗口及图片清理行为。

## 后果与防回退

- 对话与答题仍共处 `ConversationRuntime` 和一个存储端口，团队并行开发隔离尚未达到独立模块级别；新增复杂行为前应基于独立领域模块抽取，不要恢复会话 ID 推断。
- 多轮对话会持续增长上下文；profile 必须声明有界历史策略或后续补充裁剪策略，不能默认为无限发送。
- 工具调用尚未实现；新增时必须由 Agent profile 注册并经过 host 授权，不因 profile 可复用而默认向所有 profile 开放。
- 同一模型配置可能并发被多个能力使用；执行器需对每次运行捕获不可变配置快照，配置更新不得改变已开始的请求。

## 验证

- `pnpm --filter @answra/agent test`：3 个测试文件、12 项通过。
- `pnpm --filter @answra/ui test -- --run test/FloatingBarApp.test.tsx`：38 项通过。
- shared、agent、desktop、ui typecheck 均通过。
- 全量 `pnpm verify` 尚待完成；首次运行发现既有 CSS `!important` lint 警告，以及需格式化的本次代码，UI 全量测试中的 3 个 mock 断言已按新命令契约修正。
