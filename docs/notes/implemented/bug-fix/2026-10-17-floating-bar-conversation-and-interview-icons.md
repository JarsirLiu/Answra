# Note：对话入口与面试模式的图标语义

状态：已实施

## 问题

悬浮条第 2 段的「AI 对话」入口使用 `MessageSquareText`（方形气泡内含文字行）。该图形在主流图标体系里表达的是「文本/笔记/文档」，而不是「多轮对话」，与同排的截图、AI 建议等图标并列时无法体现「你来我往」的会话语义。用户反馈「多轮对话图标不对，无法代表对话」。

## 涉及范围

- 代码/模块：`packages/ui/src/model.ts`（`MODES` 中 `chat` 动作图标、`interview` 模式图标）、`packages/ui/test/FloatingBarApp.test.tsx`。
- UI/进程/协议/持久化表面：纯表现层，`ModeAction.id` / `label` / `disabled` / `hint` 与按钮可访问名均不变，不涉及 IPC 与持久化。
- 相关 Note：[悬浮条单一笔记本入口与导航图标统一尺寸](../simplification/2026-10-17-floating-bar-single-workspace-entry-and-icon-size.md)、[截图入口常驻底色与超宽间距](2026-10-17-floating-bar-screenshot-stuck-primary-tint.md)。

## 根因

`chat` 动作用的是「带文字行的方形气泡」（文档语义），而「多轮对话」在 lucide/Feather 系列里的共识图形是**两个重叠气泡** `MessagesSquare`；用户对这个差异的直觉反馈成立。

## 决定

- 三个模式的 `chat` 动作图标统一改为 `MessagesSquare`（双气泡 = 会话/对话）。三处是同一语义，必须一起改，避免模式间不一致。
- 面试模式图标原为 `MessagesSquare`；若保留，面试模式下同一根条会出现两个完全相同的图形（模式触发器 + 对话入口），因此改为 `AudioLines`（声波 = 实时语音面试），与会议模式的 `UsersRound` 也不冲突。
- 移除不再使用的 `MessageSquareText` 导入。

## 修复

- `packages/ui/src/model.ts`：三个模式的 `chat` 动作图标由 `MessageSquareText` 改为 `MessagesSquare`；`interview` 模式图标由 `MessagesSquare` 改为 `AudioLines`；导入表相应增删（`+AudioLines`、`-MessageSquareText`）。
- `packages/ui/test/FloatingBarApp.test.tsx`：新增用例，断言「AI 对话」按钮的 svg 带 `lucide-messages-square`，切到面试模式后模式触发器的 svg 带 `lucide-audio-lines`。

## 影响表面

- 笔试/面试/会议三个模式的「AI 对话」按钮图标变为双气泡；`aria-label`、`id`、点击行为不变，按名称查询按钮的既有断言不受影响。
- 面试模式左侧模式触发器图标变为声波，与中段「AI 对话」不再重形。

## 曾考虑的替代方案

- **改用 `MessageCircleMore`（单个圆形气泡 + 省略号）：** 能表达「进行中的对话」，但「多轮/双方」语义弱于双气泡，因此不采用。
- **只改 `chat` 图标、面试模式保留 `MessagesSquare`：** 面试模式下同一根条出现两个相同图形，可辨性下降，因此同时调整模式图标。
- **把 `chat` 改成 `Bot` / `Sparkles`（AI 语义）：** 表达的是「AI 能力」而非「对话」，且与同排已存在的 `Sparkles`（AI 建议）重复，因此不采用。
- **改用 `Mic` 表示面试：** 面试模式同时听系统声音（对方）与麦克风，`Mic` 会误导为「用户说话」，因此用 `AudioLines`。

## 后果与防回退

- 「AI 对话」的图形语义以 `MessagesSquare` 为准；三个模式定义必须保持同一图标，改动时三处同步。
- 模式图标与同模式内的动作图标不得使用同一个 lucide 图形（同一根条内不得出现重形图标）。
- 图标尺寸继续统一走 `packages/ui/src/tokens.ts` 的 `ICON` / `ICON_STROKE`，禁止在组件里手写尺寸。

## 验证

- `packages/ui/test/FloatingBarApp.test.tsx` 新增用例：断言「AI 对话」按钮的 svg 带 `lucide-messages-square`，切到面试模式后模式触发器的 svg 带 `lucide-audio-lines`（同时守住「同根条重形图标」回归）。
- `packages/ui` 全部 206 个测试通过；`pnpm verify` 通过。
