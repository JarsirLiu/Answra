# Note：回复工作流边界

状态：已实施

## 问题

截图、附件、草稿、发送状态和独立回复窗口同步原先都写在 `FloatingBarApp`，导致任何回复功能改动都要触碰页面组合文件，也容易让窗口通信和普通面板状态互相影响。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/app/FloatingBarApp.tsx`
- 行为表面：区域截图、文件附件、发送条、回复窗口 IPC 动作
- 相关 Note：功能边界与本地运行时分层、悬浮栏表面与任务工作流

## 决定

回复工作流由 `useReplyWorkflow` 独立持有草稿、附件、流式文本、截图调用、清理和回复窗口桥接。`FloatingBarApp` 只负责把工作流命令接到表面 coordinator，并把状态传给面板组件。

回复工作流仍使用现有 `SurfaceState.workflow` 表示表面占用和恢复关系；hook 不创建第二套面板或浮层生命周期。

## 模块边界

- `useReplyWorkflow`：任务数据和回复窗口同步，不负责普通面板开关或主题设置。
- `useSurfaceCoordinator`：工作流开始、阶段切换和结束，以及面板恢复规则。
- `FloatingBarApp`：组合导航、面板和工作流，不新增业务状态机。

## 曾考虑的替代方案

- **把截图与附件再拆成多个 hook：** 当前它们共享清理、发送和独立窗口同步，继续拆开会增加回调传递和状态竞态，因此暂不细拆。
- **让回复窗口自己保存草稿和附件：** 会使主窗口、回复窗口和未来服务端出现多个状态所有者，关闭或重连时难以恢复，因此仍由主 renderer 持有状态。

## 后果与防回退

- 新增回复动作先扩展 `ReplyBarAction` 和 `useReplyWorkflow`，不得直接在 `FloatingBarApp` 增加回复状态。
- 「回复条不得拉回主窗口」已由 [对话面板就地回复槽与功能槽架构](2026-10-18-in-place-reply-slot-and-feature-slot.md) 细化为：主窗口内联回复条必须经 `SurfaceState.featureSlot` 接入、走 `useSurfaceCoordinator`，不得绕过 coordinator 直接挂载 `ReplyBar`；独立回复窗口作为过渡形态入口已关闭，待验证后移除。
- 将来接入本地或云端模型时，服务调用应从 hook 进一步下沉到 runtime adapter，UI 只消费流式结果。

## 验证

- UI 49 项测试通过，覆盖截图成功、取消、失败、附件、发送条和窗口恢复。
- `pnpm --filter @answra/ui typecheck` 通过。
