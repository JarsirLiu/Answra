# Note：对话面板就地回复槽与功能槽架构

状态：提案

## 问题

当前主浮窗是单列纵向栈：`FloatingBar` 在顶、`panel` 插槽在下，`ChatPanel`（对话）与 `ReplyBar`（答题回复条）通过 `surfaceReducer` 的 `workflow/start` 规则互斥——工作流启动强制 `panel: "closed"`（`packages/ui/src/app/surfaceState.ts:57-67`）。展开回复详情（`ReplyConversationPopover`）只存在于独立回复窗口（`ReplyBarWindowApp`），主窗口内联 `ReplyBar` 没有 toggle 按钮（`packages/ui/src/app/FloatingBarApp.tsx:230-247` 未传 `showConversationToggle`）。截图入口散落两处：`exam` 模式的 `screenshot` action 与 `ReplyBar` 内的 Camera 按钮，均直接调 `triggerScreenshot`，未走 surface coordinator。

用户需求：在对话模式下，点击截图让对话面板就地切换为「发送条 + 回复条」形态（而非切走到独立答题模式），发送条支持叉掉图片 / 发送 / 退出回到对话；回复条跑马灯就地展示，点击展开回复详情，回复条可回退到发送条。切换与功能更新需有统一标准化接入，支持团队并行开发。

这与 [回复工作流边界](../../implemented/architecture/2026-10-11-reply-workflow-boundary.md)「回复条仍是独立 BrowserWindow，不要重新渲染回主窗口以复用状态」的既定约束正面冲突，必须显式推翻或细化。

## 涉及范围

- 代码/模块：`packages/ui/src/app/surfaceState.ts`、`packages/ui/src/app/useSurfaceCoordinator.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/components/panels/ReplyBar.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.tsx`、`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/model.ts`、新增 `packages/ui/src/components/panels/ReplySlot.tsx`。
- UI/进程/协议/持久化表面：主浮窗 panel 插槽、回复工作流阶段机、截图触发入口、对话/答题两套会话 hook 的数据源切换、独立回复窗口与主窗口内联两种 ReplyBar 形态。
- 相关 Note：[回复工作流边界](../../implemented/architecture/2026-10-11-reply-workflow-boundary.md)、[对话与答题模式分离](../../implemented/feature/2026-10-17-separate-chat-and-exam-modes.md)、[AI 能力域与复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 提案

### 1. 引入 FeatureSlot（功能槽）抽象

把「panel 插槽主区域显示什么」从 `panel` 标识里解耦，新增正交维度 `featureSlot`。`panel`（`chat` / `notes` / `settings` / `announcements` / `closed`）决定外壳与所属能力域；`featureSlot` 决定该外壳内主区域渲染哪个功能单元。当前只有 `chat` panel 需要功能槽切换，其它 panel 暂不引入。

```text
SurfaceState {
  panel: Panel
  layer: FloatingLayer
  featureSlot: {
    kind: "chat" | "reply"
    phase?: ReplyPhase            // 仅 reply slot 使用
    restoreSlot: FeatureSlotId    // 退出 reply 时回到哪个 slot
    origin: "screenshot" | "manual" // 进入 reply 的触发来源
  } | null
  floatingLayers: FloatingHostLayer[]
}
```

- `chat` slot 渲染 `ChatPanel`（对话消息流 + 输入区），数据源 `useGeneralChat`。
- `reply` slot 渲染新组件 `ReplySlot`（发送条 + 回复条 + 展开回复详情），数据源 `useScreenshotAnswer` + `useReplyWorkflow`。
- 两套 hook 仍在 `FloatingBarApp` 顶层实例化（保持各自状态不丢失），slot 切换只切渲染，不重建 hook。

### 2. ReplySlot 组件

新增 `packages/ui/src/components/panels/ReplySlot.tsx`，作为主窗口内联形态的统一载体，复用现有 `ReplyBar`（composing/streaming/done 三态）与 `ReplyConversationPopover`（展开详情）。`ReplySlot` 按 `featureSlot.phase` 与 `conversationExpanded` 局部状态组装两者，并暴露统一回调。

主窗口内联 `ReplyBar` 启用 `showConversationToggle` + `ReplyConversationPopover`（与独立回复窗口共用同一套子组件，差异仅在容器与 placement）。`ReplyConversationPopover` 内的 `ConversationComposer` 继续走 `answer.run` command。

### 3. 统一接入点：feature/* action 命名空间

`SurfaceAction` 新增命名空间化的 feature 动作，所有功能槽切换走 coordinator，禁止组件直接调 `triggerScreenshot` 或自管 phase：

- `{ type: "feature/enter-reply"; origin: "screenshot" | "manual" }`：进入 reply slot，`restoreSlot` 记录当前 slot；`origin: "screenshot"` 时由 coordinator 委托截图桥触发截图，截图成功后再置 phase=composing（截图取消不进入 reply）。
- `{ type: "feature/exit-reply" }`：退出 reply slot，回到 `restoreSlot`，清答题会话。
- `{ type: "feature/phase"; phase: ReplyPhase }`：更新 reply slot 阶段（由 `useReplyWorkflow` 上抛，等价旧 `workflow/phase`）。

`useSurfaceCoordinator` 新增 `enterReply` / `exitReply` / `setReplyPhase` 语义方法。截图触发收口到 `enterReply({ origin: "screenshot" })`，`FloatingBar` 的 exam action 与 `ReplyBar` 的 Camera 按钮统一调此方法，消除散落入口。

### 4. reducer 互斥规则调整

- `feature/enter-reply`：`featureSlot = { kind: "reply", phase, restoreSlot: state.featureSlot?.kind ?? "chat", origin }`，**不**强制 `panel: "closed"`——panel 保持 `chat`，reply slot 作为 chat panel 内的主区域内容。
- `feature/exit-reply`：`featureSlot = { kind: state.featureSlot?.restoreSlot ?? "chat", phase: undefined }`。
- `feature/phase`：仅更新 `featureSlot.phase`。
- 旧 `workflow/*` action 保留为独立回复窗口形态（detachedReplyBar）的兼容路径，或迁移独立窗口也走 feature slot。迁移期内两套并存，但主窗口内联只走 `feature/*`。

### 5. 推翻「回复条不得拉回主窗口」约束

[回复工作流边界](../../implemented/architecture/2026-10-11-reply-workflow-boundary.md) 的核心动机是避免回复条状态在主窗口与独立窗口间复用错乱。本方案不复用状态：主窗口内联 `ReplySlot` 作为默认形态，数据源是 `useScreenshotAnswer` 单一实例。原 note 的「不要拉回主窗口」约束细化为：「主窗口内联回复条必须通过 FeatureSlot 接入，不得绕过 coordinator 直接挂载 `ReplyBar`」。

独立回复窗口（`detachedReplyBar`）作为**过渡形态**保留代码但关闭入口：迁移期主窗口内联为唯一可用形态，待新设计效果验证通过后，在后续变更中移除独立窗口代码与 `detachedReplyBar` 开关，不再长期维护双形态。验证不通过则回退到保留独立窗口。

### 6. 初始化与默认

应用初始化仍默认对话模式 + `panel: "chat"` + `featureSlot: { kind: "chat" }`。答题能力（`useScreenshotAnswer`）在顶层预实例化但不激活；用户在对话内点截图 → `feature/enter-reply` 就地激活 reply slot，对话消息流与答题回复在同一 panel 插槽内切换，不丢失对话历史。退出 reply slot 回到对话时，对话历史与草稿保留。

## 模块边界

- **SurfaceState / useSurfaceCoordinator**（`packages/ui/src/app/`）：唯一的功能槽状态所有者。新增 `featureSlot` 字段与 `feature/*` action；对外暴露 `enterReply` / `exitReply` / `setReplyPhase`。reducer 规则集中维护，组件不得绕过。
- **ReplySlot**（`packages/ui/src/components/panels/ReplySlot.tsx`）：主窗口内联回复形态的渲染容器，组合 `ReplyBar` + `ReplyConversationPopover`，不持有工作流状态（状态在 `useReplyWorkflow` 与 `useScreenshotAnswer`）。独立回复窗口（`ReplyBarWindowApp`）继续独立存在，两者不共享容器代码。
- **useReplyWorkflow**（`packages/ui/src/app/`）：继续作为回复工作流阶段机与截图/发送/取消的所有者；对外暴露的 `triggerScreenshot` / `performSend` / `closeReplyBar` / `cancelReply` 不变，但调用方改为通过 coordinator 的 `enterReply` 间接触发，而非组件直接调。
- **useGeneralChat / useScreenshotAnswer**（`packages/ui/src/app/`）：数据源 hook，在 `FloatingBarApp` 顶层实例化，slot 切换不重建。两者会话 ID 隔离（`ActiveChatConversationId` / 一次性 `screenshot-${uuid}`），互不污染。
- **FloatingBarApp**：组装点，按 `panel` + `featureSlot.kind` 决定渲染 `ChatPanel` 或 `ReplySlot`；`ReplyBar` 内联渲染条件改为 `featureSlot?.kind === "reply" && !detachedReplyBar`。
- **跨进程契约**：`featureSlot` 是 `packages/ui` 内部状态，不进 `@answra/shared` 的 `OverlayMode`；IPC 侧 `ChatSendCommand` / `AnswerRunCommand` 不变。
- **并行开发接续点**：新增能力域（面试/会议）作为新 `FeatureSlotKind` 注册组件 + hook + reducer 规则，不改核心 coordinator 的现有 slot；slot 间状态隔离。

## 曾考虑的替代方案

- **复用现有 `workflow/*`，让 `workflow/start` 不再强制 `panel: "closed"`：** 舍弃。这会破坏 `restorePanel` 恢复不变量与 `surfaceState.test.ts` 的互斥测试，且 `workflow` 语义是「临时占用整个 panel 插槽」，无法表达「chat panel 内主区域切换」的正交关系，后续接入面试/会议 slot 时还要再改一次。

- **把 ReplyBar 直接挂回 ChatPanel 之上做叠加层：** 舍弃。绕过 coordinator 直接挂载正是旧边界 note 禁止的回退，状态所有权（`useGeneralChat` vs `useScreenshotAnswer`）会在同一挂载点纠缠，且无法为后续功能提供标准化接入。

- **新增独立 `panel: "reply"` 值而非正交 featureSlot：** 舍弃。`Panel` 来自 `@answra/shared` 的 `OverlayMode`，是跨进程契约；把回复条这种主窗口内联形态塞进 `OverlayMode` 会污染跨进程协议，且 panel 互斥语义会强制 reply 与 chat 不能共享外壳（Settings/Notes 面板将来想内联回复也做不到）。featureSlot 留在 ui 包内部，不跨进程。

- **完全移除独立回复窗口：** 舍弃作为长期方案，但采纳为迁移收尾目标。独立窗口在多屏/隐身场景曾有价值，但双形态长期维护成本高；改为「过渡期保留代码、关闭入口、验证后移除」，既避免迁移期用户无回复条可用，又不在本方案里直接删代码引入回退风险。

## 验收标准

- 可观察结果：对话模式下点击截图，ChatPanel 主区域就地切换为发送条（含截图缩略、叉掉图片、发送、退出）；发送后回复条跑马灯就地展示；点击展开按钮弹出回复详情 popover；回复条 done 态可回退发送条继续截图；退出发送条回到对话且对话历史/草稿保留。
- 自动化验证：`surfaceState` 补 feature slot 切换、`restoreSlot` 恢复、截图取消不进入 reply 的单元测试；`FloatingBarApp` 补 slot 渲染切换测试；`ReplyBar` 内联展开/收起 popover 测试；`pnpm notes:check` 与 `pnpm verify` 全绿。
- 需要的实机验证：Windows 实机截图就地切换、回复详情展开、回复条回退发送条、退出回对话全流程手工确认；独立回复窗口入口已关闭、不被触发。

## 风险

- 推翻旧 reply-workflow-boundary note 的「不要拉回主窗口」约束，若主窗口内联实现不彻底，可能出现状态驱动错乱。防回退：coordinator 拒绝绕过 FeatureSlot 的挂载。
- 截图入口收口到 coordinator 后，`origin: "screenshot"` 的截图取消（用户按 Esc）必须保证不进入 reply slot，否则会出现空发送条。需在 coordinator 层处理截图取消回调。
- FeatureSlot 抽象若设计过宽，可能过度工程化当前只有 chat/reply 两种 slot 的现状。缓解：先只实现 chat/reply，`FeatureSlotKind` 类型预留但 reducer 不为未实现的 slot 写规则。
- 独立窗口过渡期保留代码但入口关闭，若入口关闭不彻底可能仍被触发，产生双形态同时驱动。缓解：入口关闭改为单点开关，并在后续移除独立窗口代码的变更里彻底删除 `detachedReplyBar` 分支与 `ReplyBarWindowApp`。
