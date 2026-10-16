# Note：RichTextComposer 的接管禁写改由 ImeTextPolicy 派生（S4）

状态：已实施

## 问题

`RichTextComposer`（`packages/ui/src/components/editor/RichTextComposer.tsx`，TipTap/ProseMirror）是第三个具备文本写入能力的编辑面，但它用一套自己的布尔量实现"内置输入法接管时禁写"：

- prop `imeBlocked?: boolean` 由宿主自行判定；
- 直接落到 `attributes`：`...(imeBlocked ? { "aria-readonly": "true", "data-embedded-ime-target": "true" } : {})`；
- `handleTextInput: () => imeBlocked`、`handlePaste` 以 `imeBlocked` 早退。

后果：它与 `EmbeddedImeInput`/`ConversationComposer` 的判据不同源——后两者已改由 `imeTextPolicy` 经 `resolveImeEditorInputState` 派生只读/门控（见[只读职责拆分](../architecture/2026-10-16-ime-readonly-duty-split.md)），而这里仍是"宿主传一个布尔、组件再自己翻译成三个属性"。同时它把门控算进了 `aria-readonly`，与刚统一的"`aria-readonly` 只反映业务只读"语义相悖。这是提案 S3 起点盘点第 4 项指出的"第三个编辑器未进 adapter 体系"。

## 涉及范围

- 代码/模块：`packages/ui/src/components/editor/RichTextComposer.tsx`（prop 与属性派生）、新增 `packages/ui/test/richTextComposer.test.tsx`。
- 行为：宿主传 `textPolicy` 时，接管禁写仍生效（`handleTextInput`/`handlePaste` 仍被阻断、仍带 `data-embedded-ime-target`），但新增独立的 `data-ime-native-input-blocked` 标记；`aria-readonly` 只在业务只读时为真，不再表示门控。缺省（无 `textPolicy`）时不接管、完全可编辑——与旧的 `imeBlocked` 缺省 `false` 等价。
- 契约：不改 `packages/shared`、IPC、`ImeTextPolicy` 字段；组件对外 prop 由 `imeBlocked` 变为 `textPolicy`（无既有宿主挂载，见下）。
- 相关 Note：[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)、[TipTap 编辑器组件](../feature/2026-10-15-tiptap-composer-editor.md)、[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

1. 用 `textPolicy?: ImeTextPolicy` 取代 `imeBlocked?: boolean`；模块常量 `EXCLUDED_TEXT_POLICY = resolveImeTextPolicy({ targetOwned: false, composing: false })` 作为缺省。
2. 组件内计算 `inputState = resolveImeEditorInputState({ businessReadOnly: disabled, policy: textPolicy ?? EXCLUDED_TEXT_POLICY })`，与另外两个编辑面同源。
3. `nativeInputBlockedByIme` 驱动：`class` 加 `embedded-ime-input`、`handleTextInput` 返回真、`handlePaste` 早退，以及 `data-embedded-ime-target="true"` + 新增 `data-ime-native-input-blocked="true"`。
4. `aria-readonly` 改为只跟随 `inputState.ariaReadOnly`（业务只读）。
5. 保留 `data-ime-policy="excluded"`：本组件仍不登记进输入法租约、不参与目标发现（沿用[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)）的结论，本切片只统一判据来源，不改变其"非目标"地位。

## 模块边界

- 组件只消费共享纯函数 `resolveImeEditorInputState` / `resolveImeTextPolicy`，不再自持接管布尔量或自行翻译属性。
- 组件仍 **不是** 输入法租约目标：不产出 `data-ime-target-id`、不改 `data-ime-policy`，不接入 `imeInputTargetCoordinator`/`ImeCandidateAnchorReporter`。
- adapter 边界（哪个编辑器承载 Rime 的 composition 投影）未动：本切片不改 `EditorContent`、keydown 转发或 preedit 装饰。

## 曾考虑的替代方案

- **删除 `RichTextComposer`：** 舍弃。它是带独立特性 Note 与 `@tiptap/*` 依赖的"可复用编辑器"，且[TipTap 编辑器组件](../feature/2026-10-15-tiptap-composer-editor.md)与[只读 composer 缺陷修复](../bug-fix/2026-10-15-ime-readonly-composer-and-caret.md)明确"保留导出、不承载当前 Rime 输入"。删它是产品取舍，不是 S4 清理；无宿主只说明它当前未被使用。
- **保留 `imeBlocked`，只把 `aria-readonly` 拆出来：** 舍弃。仍留着第三套"宿主传布尔、组件翻译属性"的判据，未消除不同源。
- **完全采纳 `imeEditorAttributes`，让它成为真正的租约目标：** 舍弃。这会推翻"未接入并标记 excluded"的既有结论，并需要 ProseMirror 在协议 v2 下的 composition 投影实机证据（属 S5 阻塞项），当前无证据。
- **改用 `beforeinput` 同步拦截来取代禁写属性：** 舍弃，方向与[输入法输入路由与编辑权限分离](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)的被拒提案相同——Windows 实机已证会触发系统 IME composition 而锁死输入，必须先有平台隔离证据。

## 后果与防回退

- 三个编辑面的"业务只读 / 内置输入法门控 / `aria-readonly`"语义自此同源，均由 `imeTextPolicy` 推导；新增第四条编辑面必须复用 `resolveImeEditorInputState`，不得自设布尔量。
- `RichTextComposer` 的 `aria-readonly` 只允许等于业务只读。
- **有意保留**：DOM 可写性仍由 `handleTextInput`（组件内）承担，未改成 `beforeinput`；组件仍标记 `data-ime-policy="excluded"`。

## 验证

- 新增 `packages/ui/test/richTextComposer.test.tsx` 3 项：`targetOwned` 策略下带 `data-embedded-ime-target`/`data-ime-native-input-blocked` 且无 `aria-readonly`；业务 `disabled` 时仅有 `aria-readonly`、无门控标记；非 owner 策略下完全可编辑。
- `pnpm --filter @answra/ui typecheck` 通过；UI 全量测试通过；`pnpm verify` 全绿。
