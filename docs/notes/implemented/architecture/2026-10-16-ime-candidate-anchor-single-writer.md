# Note：IME 候选锚点/窗口面副本收口（S2b）

状态：已实施

## 问题

`ImeCandidateAnchorReporter` 仍持有两处不听命于唯一来源的推断，与 [S2a 单一写入者](2026-10-16-ime-renderer-single-writer-facts.md) 的原则冲突：

- 它把窗口焦点缓存成组件本地 `windowFocused` state，由 `window` 的 `focus`/`blur` 监听分别 `setWindowFocused(true/false)`。窗口焦点本来是浏览器的 DOM 事实，多一份副本就多一个同步时机，正是"这次是谁改的"不可判定的来源。
- 它用 DOM `anchor.readOnly` 反推"该不该画虚拟光标"。但 `readOnly` 同时承载"业务只读"和"IME 租约持有期间阻止原生写入"两种语义（见 [编辑器可编辑性策略（已否决）](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)），reporter 无法区分，会在业务只读的输入上错误绘制光标。

候选/锚点/窗口面是 S2 的最后一块：S2a 已收口 renderer 的引擎/租约/模式副本，但候选 reporter 仍残留上述副本与 DOM 反推。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx`；调用点 `packages/ui/src/components/controls/EmbeddedImeInput.tsx`、`packages/ui/src/components/panels/ConversationComposer.tsx`、`packages/ui/src/components/panels/workspace/MarkdownEditorPane.tsx`；测试 `packages/ui/test/ImeCandidateAnchorReporter.test.tsx`、`packages/ui/test/ConversationComposer.test.tsx`。
- UI/进程/协议/持久化表面：仅 renderer 候选锚点组件；不新增 IPC 频道、不改 main session/Rime/窗口层级/持久化。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[renderer 侧状态副本收口（S2a）](2026-10-16-ime-renderer-single-writer-facts.md)、[统一 IME 输入目标与窗口生命周期](2026-10-15-unified-ime-target-lifecycle.md)。

## 决定

两条事实各自对应唯一来源，reporter 只派生、不缓存：

1. **窗口焦点**：删除 `windowFocused` 本地 state。渲染时按需读取 `document.hasFocus()`；`window` 的 `focus` 事件继续触发 `refreshFocusedAnchor`（重新解析 DOM 锚点 + `bump`），`blur` 事件只清空虚拟光标的 `caretAnchor`，**不** `bump()`。
2. **虚拟光标门控**：新增 `blockNativeEditing` prop，由调用点从 `imeTextPolicy.blockNativeEditing` 传入，取代 `!anchor.readOnly` 判定。`anchor.disabled` 保留（业务禁用本身是 DOM 事实，不是引擎模式推断）。

候选发布路径不变：`visible` 只由 `state.enabled`、锚点几何和候选列表决定，与窗口焦点、`readOnly` 无关；窗口失焦时由 main 的 lease suspend 收口候选窗。

本阶段**不**做：不改候选窗 controller 的写入者拆分、窗口层级与捕获保护（S3）；不拆除 `readOnly` 的 DOM 写入职责（平台隔离未实测，保持 fail closed）。

## 模块边界

- `ImeCandidateAnchorReporter` 只消费三类输入：`state`/`generation`（来自 `imeSessionClient` 快照派生）、`blockNativeEditing`（来自 `imeTextPolicy`）、按需读取的 DOM 焦点/窗口焦点。它不得缓存任何焦点事实，也不得反推文本策略。
- `imeTextPolicy.blockNativeEditing` 是"原生写入门控"的唯一来源；reporter 不认识"业务只读"这一概念，调用点负责把业务 `disabled`/`readOnly` 与 IME 门控分开。
- 候选展示与输入模式、`readOnly` 解耦：reporter 不参与模式判断，候选 show/hide 不改变引擎状态。

## 曾考虑的替代方案

- **新增 renderer 级 window-focus store（默认 true，事件驱动），组件用 `useSyncExternalStore` 订阅：** 舍弃。它只是把副本搬进共享模块，仍需处理"初始未聚焦"与测试间状态泄漏；按需读 DOM 更贴合 S2a 已确定的"DOM 焦点只按需读取"原则，且不引入新的可变状态。
- **保留 `windowFocused` state，只把日志补齐：** 舍弃。state 需要 `setWindowFocused` 同步时机，正是顺序问题的来源；改名或加日志不消除第二个写入者。
- **继续用 DOM `readOnly` 判定虚拟光标：** 舍弃。`readOnly` 同时是"业务只读"和"IME 原生写入门控"，reporter 会把业务只读输入误判为可绘制光标的受管目标。

## 后果与防回退

- reporter 不得再引入 `windowFocused` 或 `readOnly` 之类的本地副本/DOM 反推；新增门控前先确认其唯一写入者，并优先作为派生 prop 传入。
- `blur` 处理器不得改为 `bump()`：`tick` 同时驱动候选发布，在窗口失焦时重新发布 `show` 会让 main 重新显示候选窗。
- 调用点必须传 `blockNativeEditing={imeTextPolicy.blockNativeEditing}`；漏传只会让虚拟光标消失（安全方向），不会误画。
- `readOnly` 的 DOM 写入职责此时不动；平台级系统 IME 隔离是否可替代 `readOnly` 属 S5 决策，不能借本次重构放开门控。
- 有意接受的代价：jsdom 默认 `document.hasFocus()` 为 false，相关测试需显式 mock 聚焦窗口；真实窗口聚焦时行为与原实现一致。

## 验证

- 自动化（`packages/ui/test/ImeCandidateAnchorReporter.test.tsx` 新增 3 项）：
  - `blockNativeEditing` 为真且 DOM `readOnly` 为 false 时绘制虚拟光标；
  - DOM `readOnly` 为真但未传 `blockNativeEditing` 时不绘制（证明不再嗅探 DOM）；
  - 窗口失焦（`document.hasFocus()` 变 false + `blur` 事件）后派生焦点隐藏光标。
- `packages/ui/test/ConversationComposer.test.tsx`：在聚焦窗口（mock `document.hasFocus`）下仍绘制虚拟光标；新增 `afterEach(() => vi.restoreAllMocks())` 隔离 mock。
- 门禁：`pnpm verify` 全绿（Biome、Note 门禁、全包 typecheck、UI 168 项、desktop、app、architecture check）。
- 需要实机验证（S5）：Windows 11 / macOS 窗口失焦与恢复时的光标、候选表现，以及 `readOnly` 隔离替换决策。
