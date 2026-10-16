# Note：ConversationComposer 的 IME 接线收口为会话直传（S4）

状态：已实施

## 问题

`ConversationComposer` 的 `ime` prop 是一个约 17 个字段的扁平对象，两个宿主 `ChatPanel.tsx:134-161` 与 `ReplyConversationPopover.tsx:139-166` 各自从 `useEmbeddedIme(...)` + `useControlledImeTextAdapter(...)` 的返回值逐字段搬一遍：

- 两个宿主里逐字段映射几乎逐字重复（`available/active/imeEnabled/textPolicy/shouldPreventBeforeInput/state/onKeyDown/onKeyUp/onCandidateUpdate/onFocus/onBlur/generation/onToggle` + `onTextStart/compositionRange`）。
- 其中 `onSelect`/`onNavigate` 在 `ConversationComposer` 内声明后从未被读取（死字段）。
- `targetId` 由宿主硬编码成 `"chat-composer"`/`"reply-composer"`，与传给 `useEmbeddedIme` 的第四个实参重复，二者可能漂移。
- `cancelComposition` 的 effect（`if (!ime.state.composing) controlledImeText.cancelComposition()`）在两个宿主里逐字重复。

后果：`useEmbeddedIme` 的返回结构一旦新增/改名一个成员，两个宿主都要跟着改；中间对象里字段写错或漏写不会被类型系统发现（因为是自己拼的字面量），这正是 S4「迁移遗留」要清理的一类接线。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts`（返回值补 `targetId`）、`packages/ui/src/components/panels/ConversationComposer.tsx`（新 prop 契约 + 内部接线）、`ChatPanel.tsx`、`ReplyConversationPopover.tsx`、`packages/ui/test/ConversationComposer.test.tsx`。
- 行为：无变化——每处 DOM 属性、回调与 effect 的语义逐字保留（`sendKey` 仍以 `release=false` 调用、composition 起始仍用当时的 `composing` 捕获、`cancelComposition` 仍在非 composing 时清 range）。
- 契约：不改 `packages/shared`、IPC、`ImeTextPolicy`、候选面或 `useEmbeddedIme` 现有成员语义（仅新增一个只读字段）。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[编辑器绑定收口](../architecture/2026-10-16-ime-editor-binding-single-surface-wiring.md)。

## 决定

1. `ConversationComposer` 的 `ime` prop 改为 `{ session; composition }`：
   - `session` = `Pick<ReturnType<typeof useEmbeddedIme>, "available"|"active"|"imeEnabled"|"generation"|"state"|"textPolicy"|"targetId"|"shouldPreventBeforeInput"|"sendKey"|"sendKeyUp"|"updateCandidate"|"acquire"|"blur"|"toggle">`。
   - `composition` = `Pick<ReturnType<typeof useControlledImeTextAdapter>, "compositionRange"|"captureCompositionStart"|"cancelComposition">`。
   - 用 `Pick<ReturnType<...>>` 而非手写接口，使该契约无法与 hook 返回结构漂移；组件只选取它实际使用的成员。
2. 两个宿主只传 `ime={ime.available ? { session: ime, composition: controlledImeText } : undefined}`。
3. 组件内部完成原先由宿主做的接线：`targetId` 取 `session.targetId`、`onCaptureCompositionStart` 调 `composition.captureCompositionStart(range, session.state.composing)`、`sendKey` 调 `session.sendKey(keyEvent, false, apply)`。
4. `cancelComposition` 的 effect 移入 `ConversationComposer`：composing 是会话事实，清 mirror range 是组件自己的 DOM 责任，宿主不再各自持有该 effect。
5. `useEmbeddedIme` 返回值补 `targetId`，作为 `targetId` 的唯一来源。

## 移除内容

- 两个宿主内逐字段拼装的 `ime` prop 对象，以及 `ChatPanel.tsx`/`ReplyConversationPopover.tsx` 里重复的 `cancelComposition` effect 与随之不再使用的 `useEffect` 导入。
- `ConversationComposer` prop 中从未被读取的 `onSelect`/`onNavigate` 字段。
- 宿主硬编码的 `targetId` 字面量（改由 `useEmbeddedIme` 返回值提供）。

## 重新引入条件

- 禁止任何宿主再按字段拼装 `ConversationComposer` 的 IME 接线；新增一个 IME 表面状态时，先加进 `useEmbeddedIme`（或 adapter），再在 `ConversationComposerIme` 的 `Pick` 列表里选出，最后在组件内接线。
- `targetId` 只能来自 `useEmbeddedIme` 返回值，不得在宿主重新写死。
- composition 相关的 DOM 收尾（如 mirror range 清理）归 `ConversationComposer`，宿主不再注册同类 effect。

## 曾考虑的替代方案

- **只删死字段 `onSelect`/`onNavigate`，保留扁平 prop：** 舍弃。这只修掉一处死代码，逐字段映射的重复与漂移仍在，未触及本问题的主体。
- **把 `useEmbeddedIme`/`useControlledImeTextAdapter` 的调用移进 `ConversationComposer`：** 舍弃。`draft` 状态、`bridge`、`onDraftChange`、`inputRef` 焦点语义都归宿主（`ChatPanel` 还要用同一 `composerInputRef` 做"引用回复"聚焦），hook 进组件会把这两处所有权搬错层，改动面远大于接线收口。
- **为 prop 手写显式窄接口（不复用 hook 返回类型）：** 舍弃。手写接口会与 hook 返回结构各自演化，正是本 Note 要消除的漂移来源；`Pick<ReturnType<...>>` 既窄又同源。
- **保留宿主侧 `cancelComposition` effect：** 舍弃。它读的是会话 composing、动的是组件 mirror 的 range，放在宿主是第二处知道 mirror 细节的地方。

## 后果与防回退

- `ConversationComposer` 成为"会话 → DOM 接线"的唯一映射点；宿主只负责传入 hook 返回与自身业务 props。
- `ConversationComposerIme` 的 `Pick` 列表是 hook 返回与组件用法之间的显式契约，删/改 hook 成员会在类型检查时报错。
- **有意保留**：`session.sendKey` 仍是 `useEmbeddedIme` 的三参签名（`event, release, apply`），组件固定传 `release=false`；这是 hook 的现有公共 API，不在本切片改写。

## 验证

- `packages/ui/test/ConversationComposer.test.tsx` 8 项通过：`imeProps()` 改为构造 `{ session, composition }`，新增断言 `captureCompositionStart` 以 `({ start, end }, composing)` 调用、`sendKey` 收到 `release=false`。
- `packages/ui/test/ChatPanel.test.tsx`、`ReplyBarWindowApp.test.tsx` 等宿主渲染测试通过（行为等价由原断言保证）。
- `@answra/ui` typecheck 通过；UI 全量测试通过；`pnpm verify` 全绿。
