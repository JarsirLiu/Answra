# Note：对话面板就地回复槽与功能槽架构

状态：已实施

## 问题

主浮窗原先是单列纵向栈：`FloatingBar` 在顶、`panel` 插槽在下，`ChatPanel`（对话）与 `ReplyBar`（答题回复条）通过 `surfaceReducer` 的 `workflow/start` 规则互斥——工作流启动强制 `panel: "closed"`，把对话面板整块挤走。展开回复详情（`ReplyConversationPopover`）只存在于独立回复窗口（`ReplyBarWindowApp`），主窗口内联 `ReplyBar` 没有展开入口。截图入口散落两处：`exam` 模式的 `screenshot` action 与 `ReplyBar` 内的 Camera 按钮，都直接调 `triggerScreenshot`，绕过 surface coordinator。

用户需求：对话模式下点击截图，让对话面板就地切换为「发送条 + 回复条」形态（而非切走到独立答题模式），发送条支持叉掉图片 / 发送 / 退出回对话；回复条跑马灯就地展示，可展开回复详情，可回退到发送条。切换与功能更新要有统一标准化接入，支持团队并行开发。

这与 [回复工作流边界](2026-10-11-reply-workflow-boundary.md) 的「回复条不得重新渲染回主窗口以复用状态」既定约束正面冲突，本变更显式细化该边界。

## 涉及范围

- 代码/模块：`packages/ui/src/app/surfaceState.ts`、`packages/ui/src/app/useSurfaceCoordinator.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/useReplyWorkflow.ts`、新增 `packages/ui/src/components/panels/ReplySlot.tsx`、`packages/ui/test/surfaceState.test.ts`、`packages/ui/test/FloatingBarApp.test.tsx`、`apps/desktop/src/main/window.ts`、新增 `apps/desktop/test/replyBarEntrySwitch.test.ts`。
- UI/进程/协议/持久化表面：主浮窗 panel 插槽、回复工作流阶段机、截图触发入口、对话/答题两套会话 hook 的数据源切换、独立回复窗口入口开关。
- 相关 Note：[回复工作流边界](2026-10-11-reply-workflow-boundary.md)、[对话与答题模式分离](../feature/2026-10-17-separate-chat-and-exam-modes.md)、[AI 能力域与复用](2026-10-18-ai-capability-domains-and-reuse.md)。

## 决定

1. 引入正交维度 `SurfaceState.featureSlot`：`{ kind: "chat" | "reply"; phase?: ReplyPhase; restoreSlot: FeatureSlotKind; restorePanel: Panel; origin?: "screenshot" | "manual" }`，初始 `{ kind: "chat", restoreSlot: "chat", restorePanel: "chat" }`。`panel` 决定外壳与能力域，`featureSlot` 决定该外壳主区域渲染哪个功能单元。
2. `SurfaceAction` 新增命名空间化动作，功能槽切换只走 coordinator：`feature/enter-reply`（带 `origin`）、`feature/exit-reply`、`feature/phase`。旧 `workflow/*` 保留为独立窗口形态的兼容路径。
   - `feature/enter-reply`：置 `layer: "closed"`、`panel: "chat"`、`featureSlot = { kind: "reply", phase: "composing", ... }`；连续截图（`kind` 已是 `reply`）时沿用上一层 `restoreSlot` / `restorePanel`，不覆盖。此处把 `panel` 归位到 `chat` 并记录进入前的 `restorePanel`，保证 reply slot 始终渲染在 chat 外壳内，退出时能恢复到原面板（如 `notes`）。
   - `feature/exit-reply`：`panel` 恢复为 `featureSlot.restorePanel`，`featureSlot` 回到 `restoreSlot`。
   - `feature/phase`：仅更新 `featureSlot.phase`。
3. `useSurfaceCoordinator` 暴露 `enterReply(origin)` / `exitReply()` / `setReplyPhase(phase)`，reducer 规则集中维护，组件不得自管 phase 或直接调 `triggerScreenshot`。
4. `useReplyWorkflow` 回调改为 `onEnterReply` / `onExitReply` / `onSetReplyPhase`，新增 `inline?: boolean` 并对外暴露 `conversationId`。`inline: true` 时 `detachedReplyBar` 恒为 false，不再向独立窗口推送状态。
5. 新增 `packages/ui/src/components/panels/ReplySlot.tsx` 作为主窗口内联回复形态的统一载体，复用 `ReplyBar`（composing/streaming/done）与 `ReplyConversationPopover`（展开详情），worker 状态仍由 `useReplyWorkflow` + `useScreenshotAnswer` 持有。
6. `FloatingBarApp` 作为组装点：`panel === "chat" && featureSlot.kind === "chat"` 渲染 `ChatPanel`，`panel === "chat" && featureSlot.kind === "reply"` 渲染 `ReplySlot`；`FloatingBar` 取消 `replyPhase === "closed"` 门槛改为始终渲染，`useFitContent(platform, true)`。两套 hook（`useGeneralChat` / `useScreenshotAnswer`）仍在顶层实例化，slot 切换只切渲染、不重建、不丢对话历史与草稿。
7. 独立回复窗口作为过渡形态保留代码但关闭入口：`apps/desktop/src/main/window.ts` 的 `setReplyBarWindowState` 增加单点开关 `DETACHED_REPLY_WINDOW_ENABLED: boolean = false`，非空状态直接忽略，仅放行 `null` 清理残留。

## 模块边界

- **SurfaceState / useSurfaceCoordinator**（`packages/ui/src/app/`）：唯一的功能槽状态所有者。`featureSlot` 字段与 `feature/*` action 只在此维护，对外暴露 `enterReply` / `exitReply` / `setReplyPhase`。
- **ReplySlot**（`packages/ui/src/components/panels/ReplySlot.tsx`）：主窗口内联回复形态的渲染容器，组合 `ReplyBar` + `ReplyConversationPopover`，不持有工作流阶段状态。独立回复窗口 `ReplyBarWindowApp` 代码保留但入口关闭，两者不共享容器代码。
- **useReplyWorkflow**（`packages/ui/src/app/useReplyWorkflow.ts`）：回复工作流阶段机与截图/发送/取消的所有者；阶段变更经 `onSetReplyPhase` 上抛给 coordinator，不自持 slot 状态。
- **useGeneralChat / useScreenshotAnswer**：数据源 hook，在 `FloatingBarApp` 顶层实例化；会话 ID 隔离（`ActiveChatConversationId` / 一次性 `screenshot-${uuid}`），互不污染。
- **FloatingBarApp**：组装点，按 `panel` + `featureSlot.kind` 决定渲染 `ChatPanel` 或 `ReplySlot`，不新增业务状态机。
- **跨进程契约**：`featureSlot` 是 `packages/ui` 内部状态，未进 `@answra/shared` 的 `OverlayMode`；IPC 的 `ChatSendCommand` / `AnswerRunCommand` 不变。
- **desktop 窗口（`apps/desktop/src/main/window.ts`）**：独立回复窗口入口的唯一单点开关持有者；`replyBarWindowController` 生命周期代码保留待删。
- **并行开发接续点**：新增能力域（面试/会议）作为新 `FeatureSlotKind` 注册组件 + hook + reducer 规则，不改核心 coordinator 的现有 slot；slot 间状态隔离。

## 曾考虑的替代方案

- **复用现有 `workflow/*`，只让 `workflow/start` 不再强制 `panel: "closed"`：** 舍弃。会破坏 `restorePanel` 恢复不变量与 `surfaceState` 互斥测试，且 `workflow` 语义是「临时占用整个 panel 插槽」，无法表达「chat 外壳内主区域切换」的正交关系。
- **把 ReplyBar 直接挂回 ChatPanel 之上做叠加层：** 舍弃。绕过 coordinator 直接挂载正是被禁止的回退，`useGeneralChat` 与 `useScreenshotAnswer` 的状态所有权会在同一挂载点纠缠，也无法为后续功能提供标准化接入。
- **新增独立 `panel: "reply"` 值而非正交 featureSlot：** 舍弃。`Panel` 来自 `@answra/shared` 的 `OverlayMode`，是跨进程契约；塞进回复条这种主窗口内联形态会污染协议，且 panel 互斥语义会强制 reply 与 chat 不能共享外壳。
- **完全移除独立回复窗口：** 作为长期目标采纳，但不与本次内联改造同批交付。保留代码、关闭入口，先观察内联形态效果，通过后再在后续变更里删除 `detachedReplyBar` 分支与 `ReplyBarWindowApp`，避免迁移期用户无回复条可用、也避免一次变更同时引入内联与删代码两个风险。

## 后果与防回退

- 主窗口内联回复条必须经 FeatureSlot 接入，不得绕过 coordinator 直接挂载 `ReplyBar`——这是对 [回复工作流边界](2026-10-11-reply-workflow-boundary.md) 原「不得拉回主窗口」约束的细化替代。
- `feature/enter-reply` 会主动把 `panel` 归位到 `chat` 并记录 `restorePanel`；组件内不要私自改 `panel`，否则退出 reply 时无法恢复原面板。
- 截图取消（`reason === "cancelled"`）不进入 reply slot；只有截图成功才 `onEnterReply("screenshot")`，避免出现空发送条。
- 独立窗口入口由 `window.ts` 单点开关关闭；若内联形态实机验证不通过，删除该开关即可恢复独立窗口；验证通过后连同 `replyBarController`、`ReplyBarWindowApp` 与 `detachedReplyBar` 分支一并移除。
- 新增能力域应扩展 `FeatureSlotKind` 并注册组件 + hook + reducer 规则，不改动现有 chat/reply slot。

## 验证

- `packages/ui`：`surfaceState.test.ts` 新增 feature slot 进入/退出、`restoreSlot` 跨重复截图保留、非 chat 面板进入后恢复 `restorePanel` 用例；`FloatingBarApp.test.tsx` 重写独立窗口推送、胶囊退场等旧断言为内联形态。`pnpm --filter @answra/ui test` 228 项通过。
- `apps/desktop`：新增 `replyBarEntrySwitch.test.ts`，断言入口开关忽略非空状态、仅放行 `null`。`pnpm --filter @answra/desktop exec vitest run test/replyBarEntrySwitch.test.ts` 通过。
- 类型与格式：`pnpm --filter @answra/ui exec tsc --noEmit` 通过；biome 无错误。
- 门禁：`pnpm notes:check`、`pnpm verify` 通过。
- 需要的实机验证（待办）：Windows 实机确认对话内截图就地切换、回复详情展开、回复条回退发送条、退出回对话全流程，以及独立回复窗口入口不被触发。
