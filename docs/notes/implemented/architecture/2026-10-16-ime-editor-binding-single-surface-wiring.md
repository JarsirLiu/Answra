# Note：内置输入法编辑器接线收口为共享绑定模块（S4）

状态：已实施

## 问题

每个内置输入法的宿主都在复写同一套"原生元素接线"：

- `EmbeddedImeInput` 的 `<input>`（`EmbeddedImeInput.tsx:66-120`）
- `ConversationComposer` 的 `<textarea>`（`ConversationComposer.tsx:129-195`）
- `MarkdownEditorPane` 的 CodeMirror `contentDOM`（`MarkdownEditorPane.tsx:137-204`）

三处逐字重复两件事：

1. **目标标记**：`data-embedded-ime-target` / `data-ime-policy` / `data-ime-target-id`（外加动态的 `data-ime-composition-active`、`data-embedded-ime-active`）。
2. **composition 起始键判定 + 引擎转发**：`(event.key.length === 1 || event.key === "Process") && !ctrl && !alt && !meta` 时先捕获光标，再 `sendKey(...)`，若已处理则 `preventDefault`。

后果：新增输入面（未来面试/会议等）若抄漏一步就出 IME bug；判定条件一旦要改（例如补键位），必须同时改三处。这正是提案 S4 想消除的"每加一个输入面就再抄一遍"的税。

## 涉及范围

- 代码/模块：新增 `packages/ui/src/ime/imeEditorBinding.ts`；改造 `EmbeddedImeInput.tsx`、`ConversationComposer.tsx`、`MarkdownEditorPane.tsx`；新增 `packages/ui/test/imeEditorBinding.test.ts`。
- 契约：不改 `packages/shared`、IPC、DOM 结构或数据属性名/取值；候选窗、主题、`useEmbeddedIme` 导出面不变。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

新增框架无关的纯函数模块 `imeEditorBinding.ts`（不是 React hook）：

1. `imeEditorAttributes({ targetId, active?, composing? })` → 返回 `data-*` 映射；React 宿主 `{...spread}`，CodeMirror 喂给 `EditorView.contentAttributes.of(...)`。
2. `isImeCompositionStartKey(event)` → 单一 composition 起始键判定。
3. `handleImeEditorKeyDown({ event, policy, readSelection, onCaptureCompositionStart, sendKey, applyEditorCommand })` → 满足捕获条件时先调 `onCaptureCompositionStart(readSelection())`，再 `sendKey`，返回是否已消费。

三个宿主改为调用同一函数：`readSelection` 由各自介质提供（React 用 `event.currentTarget.selectionStart/End`，CodeMirror 用 `editor.state.selection.main`），`sendKey` 各自闭包注入释放标志与 `applyEditorCommand`。

## 模块边界

- 只依赖 `imeKeyRouter`/`imeTextPolicy` 的**类型**；不 import React、CodeMirror 或任何进程模块。
- 不持有 session/focus/editor 状态；只读事件的 `key/ctrlKey/altKey/metaKey`，事件对象由调用方传入（React 合成事件或 DOM `KeyboardEvent`），因此同一函数可服务两种介质。

## 曾考虑的替代方案

- **做成 React hook `useImeEditorBinding(ime, ref)`：** 舍弃。CodeMirror 不是 React 组件，其事件是原生 `KeyboardEvent` 且处理器需返回 boolean；hook 无法服务它。只覆盖两个 React 宿主则第三面继续分叉，没达成"统一接线"。纯函数模块才能同时服务两者。
- **把三个输入面合并成一个组件：** 舍弃。`<input>`/`<textarea>` 的值模型是受控 string，CodeMirror 是 `EditorState`，受控与适配方式根本不同；合并会引入大量分支，风险远大于收益。
- **只在三个文件各 import 一个小 `isCompositionStart` 工具：** 舍弃。只消除判定重复，`attributes` 与 `sendKey` 接线仍三份，未消除主要重复。

## 后果与防回退

- 新输入面必须使用 `imeEditorAttributes` + `handleImeEditorKeyDown`；禁止再内联 composition 起始判定或手写 `data-ime-*` 标记。
- **有意保留的重复**：三处 React 宿主的 `readOnly`/`aria-readonly`/`onChange`/`onBeforeInput`/`onCompositionStart`/`onFocus`/`onBlur` 仍各自一行接线——这些受 `ConversationComposer` 的 `ime` prop 契约（`ChatPanel`/`ReplyConversationPopover` 逐字段映射）所限，收敛它们须先把该 prop 换成 `useEmbeddedIme` 的直接返回，属后续独立改动，不在本 Note 范围。

## 验证

- `packages/ui/test/imeEditorBinding.test.ts` 7 项通过（attributes 三标记/动态标记、起始键判定 3 项、handleImeEditorKeyDown 捕获与不捕获 3 项）。
- UI 全量 182 项通过（`EmbeddedImeInput`/`ConversationComposer`/`ChatPanel`/`markdownEditorPane` 等原有断言保证行为等价）；desktop 150、app 7。
- `pnpm verify` 全绿。
