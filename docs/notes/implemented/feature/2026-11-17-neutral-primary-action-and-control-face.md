# Note：中性主操作与控件亮面

状态：已实施

## 问题

主操作按钮、开关开启态和进度条共用 `--mint`，导致保存、登录、发送、下一步等按钮以及已开启的开关持续呈现品牌绿。用户明确反馈主按钮和开启态开关「还是旧的颜色」，希望主按钮改为中性深炭灰，同时保留滑杆的薄荷绿。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/tokens.css`、`packages/ui/src/components/controls/SurfaceButton.css`、`packages/ui/src/components/controls/Switch.css`、`packages/ui/src/components/panels/SettingsPanel.css`、`packages/ui/src/components/panels/ConversationComposer.css`、`packages/ui/src/components/panels/SourcesPanel.css`、`packages/ui/test/themeCss.test.ts`
- UI 表面：主操作按钮、对话发送按钮、文件选择按钮、开关开启/禁用态、设置面板「模型来源」分段选中态
- 相关 Note：[对话面板中性浅色基线与字体栈](../bug-fix/2026-10-29-chat-surface-neutral-palette.md)

## 决定

- 新增 `--action` / `--action-deep` / `--action-contrast`：浅色主题为炭灰 `#343A40` / `#1E2328` / 白色，深色主题为浅灰蓝 `#E2E9F0` / `#F2F6FA` / `#1A1F23`。
- `SurfaceButton` 的 `primary`、对话发送按钮和文件选择按钮改用 `--action`；hover 用 `--action-deep`，不再用 `brightness()` 反向调整。
- 开关开启轨道改用 `--action`，拇指改用 `--action-contrast`；禁用开启态退回中性 `--field-strong`，不再保留绿色。
- 新增 `--control-face`：浅色近白、深色浅灰蓝；用于开关拇指和设置面板分段选中态，保证在灰轨道上仍有可见亮面。
- `--mint` 继续保留给滑杆、进度条和少量非按钮强调，不整体替换品牌色。

## 影响表面

- 主操作按钮在浅色主题下从薄荷绿实底变为炭灰实底；深色主题下为浅灰蓝实底，文字自动翻转为深色。
- 开关开启态与主操作按钮同一套中性动作色，滑杆和进度条仍是薄荷绿。
- 设置面板「模型来源」选中段改为控件亮面加细描边，不再与轨道糊成同一层灰。

## 曾考虑的替代方案

- **直接把 `--mint` 改成炭灰：** 舍弃。滑杆、进度条和成功态会一起失去强调色，用户明确希望保留滑杆绿色。
- **只改主按钮，保留开关绿色：** 舍弃。用户已经指出开启态开关仍是旧颜色，开关属于交互状态面，不能继续与主操作割裂。
- **主按钮使用纯黑/纯白：** 舍弃。纯黑在浅色面板上过重，纯白在深色面板上过曝；炭灰和浅灰蓝更接近现有中性层级。
- **继续用 `filter: brightness()` 调 hover：** 舍弃。深浅主题的明度方向相反，`brightness()` 会让一个主题变亮、另一个变暗；显式 `--action-deep` 更可控。

## 后果与防回退

- 新增主操作必须使用 `--action*`，不得重新引用 `--mint`；滑杆、进度条继续使用 `--mint`。
- 开关开启态、主按钮和分段选中态的颜色分别由 `--action` 与 `--control-face` 持有；不得在组件 CSS 中写死颜色。
- 深色主题的 `--action` 是浅色面，不是炭灰；新增深色组件时不得假设 `--action` 永远为深色。
- 变色龙或前景透明度变化仍通过令牌的 `--fade` 合成，不改变组件层的颜色引用。

## 验证

- 自动化：`pnpm --filter @answra/ui test`（330 项通过）、`pnpm --filter @answra/ui typecheck`、`pnpm lint`、`pnpm tokens:check`
- 自动化：`packages/ui/test/themeCss.test.ts` 断言开关开启轨道使用 `--action` 且不含 `--mint`，主操作使用 `--action` / `--action-contrast` 且不含 `--mint`。
- 需要实机验证：浅色和深色主题下检查主按钮、开关开启/禁用态、设置分段控件和滑杆的对比度。

## 风险

- 深色主题下主操作与开关为浅色面，若后续新增固定白色文字会失去对比；必须继续使用 `--action-contrast`。
- 用户可能继续调整具体炭灰色值；改值只需更新令牌，不应在组件层新增局部颜色。
