# Note：悬浮导航功能槽就地回复架构

状态：已实施

## 问题

主浮窗原先是单列纵向栈：`FloatingBar` 在顶、`panel` 插槽在下，`ChatPanel`（对话）与 `ReplyBar`（答题回复条）通过 `surfaceReducer` 的 `workflow/start` 规则互斥——工作流启动强制 `panel: "closed"`，把对话面板整块挤走。展开回复详情（`ReplyConversationPopover`）只存在于独立回复窗口（`ReplyBarWindowApp`），主窗口内联 `ReplyBar` 没有展开入口。截图入口散落两处：`exam` 模式的 `screenshot` action 与 `ReplyBar` 内的 Camera 按钮，都直接调 `triggerScreenshot`，绕过 surface coordinator。

用户需求：点击截图后，让导航条里「截图按钮所在的功能段」原地切换成发送条 / 回复条（而不是在导航条下面另起一条独立的条）；发送条支持叉掉图片 / 发送 / 退出，回复条跑马灯就地展示，可展开回复详情、可回退到发送条。切换与功能更新要有统一标准化接入，支持团队并行开发。

这与 [回复工作流边界](2026-10-11-reply-workflow-boundary.md) 的「回复条不得重新渲染回主窗口以复用状态」既定约束正面冲突，本变更显式细化该边界。

## 涉及范围

- 代码/模块：`packages/ui/src/app/surfaceState.ts`、`packages/ui/src/app/useSurfaceCoordinator.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/useReplyWorkflow.ts`、新增 `packages/ui/src/app/useReplyDetail.ts`、新增 `packages/ui/src/components/panels/ReplyDetails.tsx`、`packages/ui/src/components/panels/ReplyBar.tsx`、`packages/ui/src/components/floating-bar/FloatingBar.tsx`、`packages/ui/test/surfaceState.test.ts`、`packages/ui/test/FloatingBarApp.test.tsx`、`apps/desktop/src/main/window.ts`、新增 `apps/desktop/test/replyBarEntrySwitch.test.ts`。
- UI/进程/协议/持久化表面：悬浮导航条功能区槽、回复工作流阶段机、截图触发入口、对话/答题两套会话 hook 的数据源切换、独立回复窗口入口开关。
- 相关 Note：[回复工作流边界](2026-10-11-reply-workflow-boundary.md)、[对话与答题模式分离](../feature/2026-10-17-separate-chat-and-exam-modes.md)、[浮窗启动收起与面板宽度跟随导航栏](../feature/2026-10-18-collapsed-startup-and-panel-width.md)。

## 决定

1. 引入正交维度 `SurfaceState.featureSlot`：`{ kind: "chat" | "reply"; phase?: ReplyPhase; restoreSlot: FeatureSlotKind; restorePanel: Panel; origin?: "screenshot" | "manual" }`，初始 `{ kind: "chat", restoreSlot: "chat", restorePanel: "chat" }`。`panel` 决定外壳与能力域，`featureSlot` 决定导航条功能区槽渲染哪个功能单元。
2. `SurfaceAction` 新增命名空间化动作，功能槽切换只走 coordinator：`feature/enter-reply`（带 `origin`）、`feature/exit-reply`、`feature/phase`。旧 `workflow/*` 保留为独立窗口形态的兼容路径。
   - `feature/enter-reply`：置 `layer: "closed"`、`panel: "chat"`、`featureSlot = { kind: "reply", phase: "composing", ... }`；连续截图（`kind` 已是 `reply`）时沿用上一层 `restoreSlot` / `restorePanel`，不覆盖。记录进入前的 `restorePanel`，退出时恢复原面板（如 `notes`）。
   - `feature/exit-reply`：`panel` 恢复为 `featureSlot.restorePanel`，`featureSlot` 回到 `restoreSlot`。
   - `feature/phase`：仅更新 `featureSlot.phase`。
3. `useSurfaceCoordinator` 暴露 `enterReply(origin)` / `exitReply()` / `setReplyPhase(phase)`，reducer 规则集中维护，组件不得自管 phase 或直接调 `triggerScreenshot`。
4. `useReplyWorkflow` 回调改为 `onEnterReply` / `onExitReply` / `onSetReplyPhase`，新增 `inline?: boolean` 并对外暴露 `conversationId`。`inline: true` 时 `detachedReplyBar` 恒为 false，不再向独立窗口推送状态。
5. 悬浮导航条的功能区槽由 `FloatingBar` 新增的 `featureSlot?: ReactNode` 承载：提供该节点时，条体右侧（模式功能段 + 工作区段）整体替换为该内容，只保留左侧模式选择；未提供时保持三段结构。回复工作流期间，`FloatingBarApp` 把 `ReplyBar`（新增 `embedded` 形态：不再自带悬浮表面，边框/底色/投影由外层 `.floating-bar` 提供）作为 `featureSlot` 注入，实现「截图按钮那一格原地变成发送条/回复条」。
6. `FloatingBarApp` 作为组装点：`featureSlot.kind === "reply"` 时把 `ReplyBar` 作为 `FloatingBar` 的 `featureSlot`；展开详情由 `useReplyDetail`（局部开合状态）驱动，展开时在导航条下方渲染 `ReplyDetails`（`useReplyConversation` + `ReplyConversationPopover`）。`panel === "chat" && featureSlot.kind === "chat"` 才渲染 `ChatPanel`。两套 hook（`useGeneralChat` / `useScreenshotAnswer`）仍在顶层实例化，slot 切换只切渲染、不重建、不丢对话历史与草稿。回复期间切换工作模式会先 `closeReplyBar()` 退出回复槽，避免功能槽与外壳 `panel` 状态打架。
7. 独立回复窗口作为过渡形态保留代码但关闭入口：`apps/desktop/src/main/window.ts` 的 `setReplyBarWindowState` 增加单点开关 `DETACHED_REPLY_WINDOW_ENABLED: boolean = false`，非空状态直接忽略，仅放行 `null` 清理残留。
8. 内嵌形态的流式/完成条改为**窄条自适应**：`.reply-bar--embedded.reply-bar--stream` 用 `width: max-content` + `max-width: min(320px, calc(100vw - 24px))`，短答案按内容收窄、超长才封顶交给跑马灯滚动；不再用固定 420 宽（短答案时会留一大片空白，视觉上比发送条长得多）。

## 模块边界

- **SurfaceState / useSurfaceCoordinator**（`packages/ui/src/app/`）：唯一的功能槽状态所有者。`featureSlot` 字段与 `feature/*` action 只在此维护，对外暴露 `enterReply` / `exitReply` / `setReplyPhase`。
- **FloatingBar**（`packages/ui/src/components/floating-bar/FloatingBar.tsx`）：三段导航条的渲染容器，新增 `featureSlot?: ReactNode` 插槽；只负责「有插槽就接管右侧、没有就渲染默认三段」，不感知回复业务。
- **ReplyBar**（`packages/ui/src/components/panels/ReplyBar.tsx`）：回复条三种形态的统一渲染单元；新增 `embedded` 形态用于嵌入导航条，不持有阶段的业务状态。独立回复窗口 `ReplyBarWindowApp` 代码保留但入口关闭，两者不共享容器代码。
- **useReplyDetail**（`packages/ui/src/app/useReplyDetail.ts`）：回复详情开合状态的所有者（composing 自动折叠、Escape 收起），与 `featureSlot.phase` 解耦。
- **ReplyDetails**（`packages/ui/src/components/panels/ReplyDetails.tsx`）：导航条下方详情面板，组合 `useReplyConversation` + `ReplyConversationPopover`，只在展开时挂载。
- **useReplyWorkflow**（`packages/ui/src/app/useReplyWorkflow.ts`）：回复工作流阶段机与截图/发送/取消的所有者；阶段变更经 `onSetReplyPhase` 上抛给 coordinator，不自持 slot 状态。
- **useGeneralChat / useScreenshotAnswer**：数据源 hook，在 `FloatingBarApp` 顶层实例化；会话 ID 隔离（`ActiveChatConversationId` / 一次性 `screenshot-${uuid}`），互不污染。
- **FloatingBarApp**：组装点，按 `featureSlot.kind` 决定注入 `ReplyBar` 还是渲染 `ChatPanel`，不新增业务状态机。
- **跨进程契约**：`featureSlot` 是 `packages/ui` 内部状态，未进 `@answra/shared` 的 `OverlayMode`；IPC 的 `ChatSendCommand` / `AnswerRunCommand` 不变。
- **desktop 窗口（`apps/desktop/src/main/window.ts`）**：独立回复窗口入口的唯一单点开关持有者；`replyBarWindowController` 生命周期代码保留待删。
- **并行开发接续点**：新增占用功能槽的能力域（面试/会议）向 `FloatingBar` 的 `featureSlot` 注入自己的组件、扩展 `FeatureSlotKind` + reducer 规则即可，不改核心 coordinator 的现有 slot；slot 间状态隔离。

## 曾考虑的替代方案

- **把回复条作为独立条渲染在导航条下方（本变更早期实现）：** 舍弃。用户要的是「截图按钮那一格功能槽原地切换」，另起一条与预期不符；独立条还会与导航条争夺宽度与对齐。
- **只替换中间功能段、保留右侧工作区段：** 舍弃。发送条需要放缩略图 + 跑马灯 + 操作组，窄的功能段会与工作区按钮争夺空间；整体接管右侧更干净，也避免回复期间误触笔记本/设置造成导航与工作流冲突。
- **复用一个固定高度、整条被替换的方案（连模式选择也隐藏）：** 舍弃。保留模式选择让用户知道当前处在哪个模式，且退出后可无缝回到原导航。
- **复用现有 `workflow/*`，只让 `workflow/start` 不再强制 `panel: "closed"`：** 舍弃。会破坏 `restorePanel` 恢复不变量与 `surfaceState` 互斥测试，且 `workflow` 语义无法表达「导航条功能区槽切换」。
- **把 ReplyBar 直接挂回 ChatPanel 之上做叠加层：** 舍弃。绕过 coordinator 直接挂载正是被禁止的回退，两套会话 hook 会在同一挂载点纠缠，也无法为后续功能提供标准化接入。
- **新增独立 `panel: "reply"` 值而非正交 featureSlot：** 舍弃。`Panel` 来自 `@answra/shared` 的 `OverlayMode`，是跨进程契约；塞进回复条这种主窗口内联形态会污染协议。
- **完全移除独立回复窗口：** 作为长期目标采纳，但不与本次改造同批交付。保留代码、关闭入口，先观察内联形态效果，通过后再在后续变更里删除 `detachedReplyBar` 分支与 `ReplyBarWindowApp`。

## 后果与防回退

- 主窗口内联回复条必须经 FeatureSlot 接入，不得绕过 coordinator 直接挂载 `ReplyBar`——这是对 [回复工作流边界](2026-10-11-reply-workflow-boundary.md) 原「不得拉回主窗口」约束的细化替代。
- `feature/enter-reply` 会主动把 `panel` 归位到 `chat` 并记录 `restorePanel`；组件内不要私自改 `panel`，否则退出 reply 时无法恢复原面板。
- 回复期间导航条右侧整体被功能槽接管：工作区入口（笔记本/公告/设置）暂时让位，属预期行为，不要为了「一直可见」把工作区段塞回功能槽内。
- 截图取消（`reason === "cancelled"`）不进入 reply slot；只有截图成功才 `onEnterReply("screenshot")`，避免出现空发送条。
- 内嵌回复条宽度用「max-content + 上限」而不是固定宽度；提高上限时要同时确认跑马灯视口仍够宽，不要把 `max-width` 去掉恢复撑满。
- 独立窗口入口由 `window.ts` 单点开关关闭；若内联形态实机验证不通过，删除该开关即可恢复独立窗口；验证通过后连同 `replyBarController`、`ReplyBarWindowApp` 与 `detachedReplyBar` 分支一并移除。
- 新增能力域应扩展 `FeatureSlotKind` 并向 `FloatingBar.featureSlot` 注入组件 + 注册 hook + reducer 规则，不改动现有 chat/reply slot。

## 验证

- `packages/ui`：`surfaceState.test.ts` 覆盖 feature slot 进入/退出、`restoreSlot` 跨重复截图保留、非 chat 面板进入后恢复 `restorePanel`；`FloatingBarApp.test.tsx` 断言回复条渲染在 `.floating-bar` 内（`document.querySelector(".floating-bar .reply-bar")`）、回复期间工作区入口让位、截图不再推送独立窗口、`收起回复条` 逐级回退。`pnpm --filter @answra/ui test` 228 项通过。
- `apps/desktop`：新增 `replyBarEntrySwitch.test.ts`，断言入口开关忽略非空状态、仅放行 `null`。`pnpm --filter @answra/desktop exec vitest run test/replyBarEntrySwitch.test.ts` 通过。
- 类型与格式：`pnpm --filter @answra/ui exec tsc --noEmit` 通过；biome 无错误。
- 门禁：`pnpm notes:check`、`pnpm verify` 通过。
- 需要的实机验证（待办）：Windows 实机确认点击截图后导航条功能槽就地变成发送条/回复条、缩略图与跑马灯在条内展示、短答案时条体收窄、回复详情在导航条下方展开、回复条回退发送条、退出回对话全流程，以及独立回复窗口入口不被触发。
- 需要的实机验证（待办）：Windows 实机确认点击截图后导航条功能槽就地变成发送条/回复条、缩略图与跑马灯在条内展示、回复详情在导航条下方展开、回复条回退发送条、退出回对话全流程，以及独立回复窗口入口不被触发。
