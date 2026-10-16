# Note：移除回复条弹层的内置输入法开关按钮

状态：已实施

## 问题

回复条展开的“当前对话”弹层输入框（`ReplyConversationPopover` 内的 `ConversationComposer`）底部渲染了一枚 `Languages` 图标按钮，`aria-pressed` 取 `ime.session.active`，`title` 为“关闭内置输入法/启用内置输入法”。实际使用中它有两个问题：

- 它只表达“内置 IME 是否启用”，**不反映也不切换中英文模式**——中英由 Rime/schema 的 Shift 语义决定（见[Shift 切换语言](../../implemented/feature/2026-10-15-ime-shift-language-toggle.md)）。用户按它的字面理解期待“中英文切换”，看到图标不随模式变化，判定为无用控件。
- 弹层是窄面板，按钮占据输入区左下角空间，收益却接近于零：隐身模式下系统 IME 已被全局禁用，关闭内置 IME 后会失去可用的中文输入路径。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ConversationComposer.tsx`（新增可选开关）、`packages/ui/src/components/panels/ReplyConversationPopover.tsx`（宿主选择关闭）。
- UI 表面：仅回复条弹层的输入框渲染结果；主窗口多轮对话面板（`ChatPanel`）的内置输入法开关保留。
- 不涉及：`useEmbeddedIme` 会话语义、`packages/shared` 协议、IPC、候选窗、隐身策略、持久化。
- 相关 Note：[内置 Rime 输入法](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)、[Shift 切换语言](../../implemented/feature/2026-10-15-ime-shift-language-toggle.md)、[ConversationComposer 的 IME 接线收口（S4）](2026-10-16-conversation-composer-ime-prop-unification.md)。

## 决定

- `ConversationComposer` 新增 `showImeToggle?: boolean`（默认 `true`），仅在为真时渲染该按钮；`ReplyConversationPopover` 传 `showImeToggle={false}`。
- 用 prop 而不是 CSS `display: none` 隐藏：后者会把按钮留在可访问性树与 Tab 语义之外却仍被辅助技术读出，与“删除控件”的语义不符。仓库内 `conversation-composer-add` 用 CSS 隐藏是“窄面板不需要附件入口”的视觉收窄，与本例不同。

## 移除内容

- 回复条弹层中的内置输入法开关按钮（以及该面板内唯一对 `session.toggle` 的调用点）。

## 重新引入条件

- 若未来确实要在窄面板提供中英文切换，必须新增**读 `session.inputMode`** 的控件并接入 IME 协议，不得复用只表达 `enabled` 的开关——否则会重复本次的误导。
- 弹层内若重新引入内置 IME 开关，需要同时回答“关闭后用户用什么输入中文”（隐身禁用系统 IME 的前提下），否则该控件仍是空操作入口。

## 曾考虑的替代方案

- **CSS 隐藏该按钮：** 舍弃。控件仍可被键盘/辅助技术感知，属于“看得见的移除、看不见的残留”。
- **把按钮改成真正的中英切换控件：** 舍弃（本次范围外）。中英模式属 Rime schema 状态，切换语义由 Shift 与引擎决定；自绘一个绝对模式开关会与该语义竞争，历史上正因如此才把 Shift 改为按原生规则处理。
- **两个面板都删：** 舍弃。主面板有充足空间，开关在那里是关闭/启用内置 IME 的显式入口，删除会削弱可发现性。

## 后果与防回退

- 弹层内不再能关闭内置输入法；IME 仍默认启用（`useEmbeddedIme(..., enabled = true)`），Shift 仍切换中英，功能不缺失。
- 若后续把 `showImeToggle` 默认值改成 `false`，等于同时移除了主面板入口，必须单独评估。
- 新增 `ConversationComposer` 宿主时，若该面板同样窄小且无中英切换诉求，应显式传 `showImeToggle={false}`，而不是靠 CSS 收窄。

## 验证

- `packages/ui/test/ConversationComposer.test.tsx`：新增“宿主选择关闭时不渲染开关、输入框仍可用”用例。
- `packages/ui/test/ReplyBarWindowApp.test.tsx`：弹层集成断言“消息输入可见且无内置输入法开关”。
- 运行 `pnpm verify`（lint + 文档门禁 + typecheck + vitest + 架构守护）。
- 待实机验证：Windows 回复条弹层底部只剩发送按钮，Shift 仍能切换中英，输入与候选窗不受影响。

