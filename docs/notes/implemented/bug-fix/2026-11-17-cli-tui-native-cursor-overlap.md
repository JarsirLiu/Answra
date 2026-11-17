# Note：CLI TUI 输入光标与下边框重叠

状态：已实施

## 问题

CLI TUI 的输入框同时渲染了反色光标单元格和 Ink 原生终端光标。输入 `/resume ` 这类带参数提示的命令时，参数提示行出现，原生光标在 `App` 布局中被停到输入框下边框所在行，和输入行末尾的反色光标叠成一个跨两行的高块，看起来像光标穿出了输入框。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/composer/TextInput.tsx`：移除 Ink `useCursor` 原生光标停放，只保留反色光标单元格。
  - `apps/cli/src/tui/composer/inputLayout.ts`：删除只服务于原生光标的 `cursorCellAt`/`CellPosition`。
  - `apps/cli/test/tui/composer/tui.composer.test.tsx`：新增“输入末尾不显示原生光标”回归测试。
  - `apps/cli/test/tui/app/tui.render.test.tsx`：原 IME 原生光标测试改为断言不再停放原生光标。
  - `apps/cli/test/tui/composer/inputLayout.test.ts`：删除 `cursorCellAt` 测试。
- UI 表面：只影响 CLI TUI 输入光标；命令候选、参数提示、输入值、选区、历史和多行布局不变。
- 相关 Note：
  - [CLI TUI 命令候选与参数提示 UI](../feature/2026-11-17-cli-command-hint-ui.md)
  - [CLI TUI UI 目录架构](../architecture/2026-11-14-cli-tui-ui-directory-architecture.md)

## 决定

按 Claude Code 的输入光标做法，只渲染一个反色光标单元格，不再额外调用 Ink `useCursor` 停放原生终端光标。

`measureElement` 返回的是布局坐标，不是终端输出视口坐标；在 `App` 的 transcript/composer/status 组合布局里，直接把布局坐标交给 `useCursor` 会让原生光标比反色光标低一行。与其在 `TextInput` 里猜一个偏移，不如移除第二个光标来源。

## 根因

1. `TextInput` 在输入行末尾渲染 `<Text inverse> </Text>`。
2. 同一组件又通过 `useCursor` + `measureElement` 把原生终端光标停到输入框内。
3. `App` 布局中 `measureElement` 的 y 与 Ink 输出行存在偏移；参数提示行出现后，原生光标落在输入框下边框，和反色光标叠成高块。

## 修复

- 删除 `TextInput` 中的 `useCursor`、`useBoxMetrics`、`measureElement` 和 `inputRef`。
- 删除 `inputLayout` 中不再使用的 `cursorCellAt` 与 `CellPosition`。
- 保留 `renderLine` 的反色光标；空输入仍用反色空格表示光标。
- 测试改为断言不出现原生光标 show 序列，并保留输入布局、宽字符列和命令提示测试。

## 曾考虑的替代方案

- **把原生光标 y 减 1：** 舍弃。偏移来自具体布局组合，换布局或改 transcript 高度后会再次错位。
- **只在参数提示行显示时隐藏原生光标：** 舍弃。原生光标在其他布局下也可能落到边框，只是没有提示行时不明显。
- **保留双光标并调整反色光标位置：** 舍弃。反色光标位置由输入布局直接决定，是正确来源；应删除错误来源。
- **继续用 `measureElement` 换算输出坐标：** 舍弃。`measureElement` 明确返回布局坐标，不能直接当作终端输出坐标使用。

## 后果与防回退

- 输入光标只由 `TextInput` 的反色单元格表示，不再有原生终端光标叠加。
- 如果未来需要 IME 候选窗精确跟随光标，必须基于 Ink 输出视口坐标单独实现，不能重新把 `measureElement` 的布局坐标直接交给 `useCursor`。
- 不要再为输入框增加第二个光标来源；选区、反色光标和原生光标同时存在会再次产生重叠。

## 验收标准

- 输入 `/resume ` 时，光标保持为输入行内的单格反色光标，不跨到下边框。
- 输入普通文本、宽字符和 emoji 时，反色光标列与显示宽度一致。
- 命令候选、参数提示、Tab 补全、Enter 执行和 Esc 关闭行为不变。
- 渲染输出不包含原生光标 show 序列。

## 验证

- 2026-11-17：`apps/cli/test/tui/composer/tui.composer.test.tsx` 18 项、`inputLayout.test.ts` 12 项、`tui.render.test.tsx` 7 项通过。
- 2026-11-17：完整 `@answra/cli` 测试 51 个文件、318 项通过。
- 2026-11-17：改动文件 `biome check` 与 `pnpm notes:check` 通过。
- 未取得全 workspace typecheck：工作区存在无关的 agent process 改动类型错误（`SHELL_OUTPUT_BUFFER_BYTES` 等），本次未触碰该范围。
