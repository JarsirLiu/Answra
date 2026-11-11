# Note：面试清空撤销浮窗接入并恢复回复取消

状态：已实施

## 问题

面试演练的「清空」本应直接执行，却被未经确认地接到独立浮窗确认。实机中隐身窗口点击不可靠，用户点击清空后无法完成操作。同时，文本回复进入流式状态后发送键被禁用，但没有可用的停止按钮，用户无法中断正在生成的回答。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/app/InterviewFeaturePanel.tsx`
  - `packages/ui/src/app/useInterviewConversation.ts`
  - `packages/ui/src/components/panels/InterviewCapturePanel.tsx`
  - `packages/ui/test/InterviewCapturePanel.test.tsx`
  - `packages/ui/test/FloatingBarApp.interview.test.tsx`
- UI/进程/协议/持久化表面：不新增 IPC、频道或持久化；复用既有 `cancelConversationRun`。
- 相关 Note：
  - [声明式浮窗系统 P0](../architecture/2026-11-11-declarative-surface-p0.md)
  - [面试演练与面试记忆](../feature/2026-11-10-interview-rehearsal-and-memory.md)

## 决定

- 撤销 `InterviewFeaturePanel` 与 `InterviewCapturePanel` 的浮窗清空接入，恢复点击「清空」直接调用原 `onClear`。
- 浮窗底层与 `interview.clear-confirm` 预设暂时保留但没有产品入口；重新接入必须有独立需求并先完成 Windows 隐身实机验证。
- 面试回复取消复用聊天已有的 `cancelConversationRun`：回复流式期间发送键原位切换为「停止回复」，点击后取消当前 `activeRunId`。
- 语音采集中仍显示「停止语音输入」并停止采集；回复取消与语音采集停止互不替代。

## 根因

清空回退来自把 `onRequestClear` 接到 `showSurface`，而浮窗在隐身模式下无法可靠接收点击，确认动作无法回传。

回复无法取消是因为 `InterviewCapturePanel` 只把 `running`（语音采集状态）传给 composer；助手回复的 `replying` 只用于禁用发送，没有驱动停止按钮。

## 修复

- `InterviewFeaturePanel` 删除 `showSurface`、`onSurfaceAction` 和浮窗打开状态，清空恢复直接执行；从 `useInterviewConversation` 取 `cancel`。
- `useInterviewConversation` 暴露 `cancel`，调用 `platform.cancelConversationRun(view.activeRunId)`。
- `InterviewCapturePanel` 新增 `onCancel`；`replying && onCancel` 时 composer 进入停止态，标签为「停止回复」。
- 只有平台实现 `cancelConversationRun` 时才提供取消入口，避免浏览器预览或测试桥出现无效按钮。
- 删除只覆盖浮窗清空确认的 `FloatingBarApp.surface.test.tsx`；清空行为继续由既有面试测试覆盖。

## 曾考虑的替代方案

- **保留浮窗，只修隐身点击：** 舍弃。清空本来不需要浮窗，继续扩大窗口交互改动不符合需求。
- **撤销整个 P0 浮窗底层：** 未采用。当前选择只撤销产品接入，底层保留待评审；但它没有产品入口，不能被描述为已交付用户功能。
- **回复期间继续禁用发送：** 舍弃。模型可能长时间输出或卡住，用户必须能主动结束本轮。
- **用清空或关闭面板代替取消：** 舍弃。两者会丢失上下文或隐藏状态，不是取消当前 run。

## 验收标准

- 点击面试「清空」直接调用 `clearConversationMessages`，不再打开浮窗。
- 回复流式期间发送键变为「停止回复」，点击调用 `cancelConversationRun` 并传入当前 run id。
- 空输入、发送 pending、语音采集三种状态仍保持原有行为。
- 自动化验证：`InterviewCapturePanel.test.tsx` 覆盖停止回复按钮；`FloatingBarApp.interview.test.tsx` 覆盖取消调用与直接清空。

## 风险

- 取消按钮依赖 `activeRunId`；如果快照没有返回活动 run，停止按钮不会出现。该字段由会话快照与运行事件共同保证。
- 浮窗底层仍保留但没有消费者，属于待评审代码；在重新接入前不得扩大其使用范围。

## 后果与防回退

- 面试清空不得再次接入浮窗或新增确认步骤，除非有明确需求和实机验证。
- 面试回复的 composer 必须同时表达「语音采集中」和「助手回复中」两种停止语义，不能只保留其中一个。
- 取消必须走 `cancelConversationRun`，不得用清空、断开连接或隐藏面板代替。

## 验证

- `pnpm --filter @answra/ui test`：43 个测试文件、307 个测试通过。
- `pnpm --filter @answra/ui typecheck`：通过。
- `pnpm exec biome check`（涉及文件）：通过。
- `pnpm notes:check`：本 Note 通过；仓库中另有未跟踪的 `2026-11-11-ui-primitive-and-proportion-contract.md` 格式不完整，与本变更无关。
