# Note：拆分文本控件的业务只读与内置输入法原生写入门控（S4）

状态：已实施

## 问题

文本控件的 DOM `readOnly` 被同时用于两件事：

1. **业务只读**：宿主自己的状态（`ConversationComposer` 的 `disabled`、`EmbeddedImeInput` 的 `props.readOnly`）。
2. **内置输入法门控**：`imeTextPolicy.blockNativeEditing`，用于阻止 Chromium 把聚焦元素交给平台 IME（Windows TSF）。

调用点把二者 OR 进同一属性：`ConversationComposer.tsx:143` `readOnly={disabled || Boolean(ime?.textPolicy.blockNativeEditing)}`、`EmbeddedImeInput.tsx` `readOnly={blockNativeEditing || props.readOnly}`；`EmbeddedImeInput` 的 `aria-readonly` 也把门控算进无障碍状态。

后果：

- **无障碍语义错误**：内置输入法接管时读屏器被告知"只读"，但用户其实能通过输入法正常输入。
- **S5 无法干净替换**：将来用已实测的平台隔离替换门控时，无法在不触碰业务只读与无障碍语义的前提下，移除门控对 `readOnly` 的贡献。

## 涉及范围

- 代码/模块：`packages/ui/src/ime/imeTextPolicy.ts`（新增纯函数）、`EmbeddedImeInput.tsx`、`ConversationComposer.tsx`、`packages/ui/test/imeTextPolicy.test.ts`、`packages/ui/test/ConversationComposer.test.tsx`。
- 行为：DOM `readOnly` 取值不变（仍是二者并集，现有定向测试保持通过）；`aria-readonly` 改为只反映业务只读（`EmbeddedImeInput` 的门控不再计入）；新增门控可观测标记。
- 契约：不改 `packages/shared`、IPC、`ImeTextPolicy` 现有字段、候选窗或媒体属性名。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

1. 新增纯函数 `resolveImeEditorInputState({ businessReadOnly, policy })` → `{ readOnly, ariaReadOnly, nativeInputBlockedByIme }`。
2. 两个控件统一改用它：`ConversationComposer` 的 `businessReadOnly = disabled`；`EmbeddedImeInput` 的 `businessReadOnly = Boolean(props.readOnly)`。
3. DOM `readOnly = businessReadOnly || nativeInputBlockedByIme`（机制不变）。
4. `aria-readonly = businessReadOnly || undefined`：无障碍状态只表示业务只读，不再表示门控。
5. 新增 `data-ime-native-input-blocked="true"`，仅在门控为真时出现，使门控独立可断言，供 S5 定位。

## 模块边界

- 纯函数，只依赖 `ImeTextPolicy`；不读 DOM、焦点、session 或进程状态。
- 门控事实仍由 `imeTextPolicy.resolvedImeTextPolicy.blockNativeEditing` 单一来源产出，调用点不再是"谁 OR 谁"的临时决定。

## 曾考虑的替代方案

- **把业务只读与门控拆到两个不同 DOM 属性：** 舍弃。`readOnly` 是唯一能暂停原生写入的 DOM 属性；`disabled` 会改变可聚焦性与表单提交语义，不能用来承载门控。单属性因此必须保留并集，本切片拆的是"事实与可观测通道"，不是属性本身。
- **只改 `ConversationComposer`（`readOnly` 去掉 `disabled ||`）：** 舍弃（不完整）。`ConversationComposer` 的业务态确实已由独立的 `disabled` 表达，可只留门控；但 `EmbeddedImeInput` 的业务只读就是 `props.readOnly`，没有第二通道。只改一处会让两控件语义不一致，且无障碍混淆仍在。
- **不动，等 S5 平台隔离定案：** 舍弃。无障碍语义当前就是错的（对可输入控件报只读），且门控没有可观测出口，S5 替换时更难定位。

## 后果与防回退

- 调用点不得再自行 OR 业务只读与门控，必须经 `resolveImeEditorInputState`。
- `aria-readonly` 只允许等于 `businessReadOnly`。
- **有意保留**：DOM `readOnly` 仍是并集（单属性所限）；门控来源仍是 `blockNativeEditing`，S5 平台实测前不得移除其 `readOnly` 贡献。

## 验证

- 单测 `resolveImeEditorInputState` 3 项（门控 alone、业务 alone、全可编辑）；`imeTextPolicy.test.ts` 12 项通过。
- `ConversationComposer.test.tsx` 8 项通过，含新增"门控标记存在、`aria-readonly` 缺席、业务 `disabled` 时 `aria-readonly=true`"断言。
- UI 全量、desktop 150、app 7；`pnpm verify` 全绿。
