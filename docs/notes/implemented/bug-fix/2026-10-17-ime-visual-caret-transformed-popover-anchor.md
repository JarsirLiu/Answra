# Note：回复条弹层输入光标被动画残值 transform 错位

状态：已实施

## 问题

回复条展开的“当前对话”弹层里，输入框的**自绘输入光标水平偏移约一个字符宽**（看起来像停在占位文字“继|续输入消息…”中间），而同一弹层内打字时的预编辑文本、原生候选窗口、以及多轮对话面板（`ChatPanel`）的输入光标全部正常。因为两处输入用的是同一颗 `ConversationComposer` 与同一条 `useEmbeddedIme` 链路，问题不在“用了不同组件”，而在弹层自身的定位上下文。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx`（自绘光标 `.ime-visual-caret` 的渲染位置）、`packages/ui/src/components/panels/ReplyConversationPopover.css`（弹层入场动画的 fill 模式）。
- 测试：`packages/ui/test/ImeCandidateAnchorReporter.test.tsx`。
- UI/进程/协议/持久化表面：仅 renderer 内浮层的绘制位置；不改 IME 会话协议、候选锚点上报、窗口角色/焦点、采集与持久化。
- 相关 Note：[内置 Rime 输入法](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)、[恢复 Rime 只读输入与对话光标](../../implemented/bug-fix/2026-10-15-ime-readonly-composer-and-caret.md)、[统一 IME 输入目标与窗口生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)。

## 根因

- IME 租约期间输入框为 `readOnly`，浏览器不再绘制原生 caret，改由 `ImeCandidateAnchorReporter` 自绘 `.ime-visual-caret`。该元素是 `position: fixed`，坐标来自 `measureInputCaret` 的**视口坐标**（`rect.left/rect.top`）。
- CSS 规则：祖先元素只要带有非 `none` 的 `transform`（以及 `filter`/`backdrop-filter`/`will-change` 等同类属性），就会成为其后代 `position: fixed` 元素的**包含块**，fixed 坐标不再相对视口。
- `.reply-conversation-popover` 的入场动画 `animation: reply-conversation-enter 150ms ease-out both`，关键帧含 `transform: translateY(...)`；`both` 使动画结束后 `transform` 仍保持 `translateY(0)`，弹层因此恒为包含块，光标的视口坐标被额外叠加一份弹层自身偏移（≈10px，接近 12px 字宽），表现即“偏一位”。
- 多轮对话面板祖先链没有这类属性，故正常；composition 投影镜像 `ControlledTextCompositionMirror` 本来就 portal 到 `document.body`，故打字与候选锚点正常。三个现象因此完全一致。

## 决定

- 自绘光标改为 **portal 到 `document.body`**，与 composition 投影采用同一策略，使光标定位不再取决于任何祖先是否构成包含块。
- 同时去掉弹层入场动画的 `both`（保留 150ms 滑入，动画结束后 `transform` 归零），消除“动画残值 transform”这一对弹层内**所有** fixed 后代的隐式陷阱。

## 修复

- `ImeCandidateAnchorReporter.tsx`：`createPortal(..., document.body)` 渲染 `.ime-visual-caret`。
- `ReplyConversationPopover.css`：`animation: reply-conversation-enter 150ms ease-out;`（去掉 `both`）。
- `ImeCandidateAnchorReporter.test.tsx`：光标断言改为 `document` 查询并断言父节点为 `document.body`；新增带 `host.style.transform` 的回归用例，断言光标不落在带 transform 的祖先内。

## 曾考虑的替代方案

- **只把 `.ime-visual-caret` 改为 `position: absolute` 并按弹层坐标换算：** 舍弃。需要自行判断“最近定位祖先”并复刻包含块规则，等于把浏览器布局规则再实现一遍，且在 portal/嵌套浮层下必然再次分叉。
- **只去掉动画 fill 模式、不改 portal：** 舍弃。这能修好当前弹层，但任何未来给浮层加 `transform`/`backdrop-filter`（例如模糊玻璃）的改动都会静默复发；portal 是把“光标恒按视口定位”变成结构性不变量的唯一单点。
- **把光标改由主进程原生窗口绘制：** 舍弃。跨进程同步成本高，且与候选窗锚点的现有分工冲突——锚点由 renderer 测量上报、绘制仍应留在 renderer。
- **让输入框在 IME 租约期间保留原生 caret：** 舍弃。租约期间禁止原生编辑是既有安全边界（隐身模式不许系统 IME 介入），自绘光标是该边界的派生物。

## 后果与防回退

- `.ime-visual-caret` 的 DOM 位置不再位于 reporter 子树内：任何“在容器内查询光标”的测试或按浮层作用域限定光标的样式（如 `.reply-conversation-popover .ime-visual-caret`）都将失效；样式必须保持全局 `position: fixed` 与根变量取色。
- 约束：**浮层祖先不得在含有 fixed 后代时使用 `transform`/`filter`/`backdrop-filter`/`will-change` 并期待视口定位**；需要入场动画时不要用 `both`/`forwards` 留下 transform 残值。
- 本修复只解决“自绘光标错位”，不改变候选窗位置（由测量锚点决定，本来就正确），也不改变窗口坐标缩放策略。

## 验证

- 自动化：`pnpm --filter @answra/ui exec vitest run test/ImeCandidateAnchorReporter.test.tsx test/ConversationComposer.test.tsx` → 20/20 通过（含新增的 transform 祖先回归用例）。
- 待实机验证：Windows 下打开回复条对话弹层并聚焦输入框，确认自绘光标与占位文字左缘对齐，且与多轮对话面板表现一致；顺带确认弹层滑入动画仍在。

