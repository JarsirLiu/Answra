# Note：Windows 下 TUI 焦点指针不显示

状态：已实施

## 问题

Windows 的 `cmd.exe` / Windows Terminal 配合部分中文字体时，CLI TUI 的聚焦指针 `❯`（U+276F）没有可显示字形，行首变成空白。用户只能靠颜色和加粗判断焦点，容易误以为键盘焦点丢失。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/chrome/theme.ts`
- 测试：`apps/cli/test/tui/app/tui.render.test.tsx`
- UI 表面：所有通过共享 `POINTER` 渲染聚焦状态的 TUI 列表与输入框；`ModelPicker`、`ModelSetupPanel` 等面板内仍硬编码的 `❯` / `✓` 不在本次范围
- 相关 Note：`docs/notes/implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md`、`docs/notes/implemented/feature/2026-11-19-cli-session-list-aligned-columns.md`、`docs/notes/implemented/bug-fix/2026-11-20-cli-compaction-origin-double-circle.md`

## 根因

`POINTER` 硬编码为 `❯`，终端字体缺字形时 Ink 仍按宽度布局，但视觉上输出空白。Claude Code 在 Windows 上用 `figures` 回退为 ASCII `>`，同类列表不会出现该问题。

## 决定

- `POINTER` 按 `process.platform === "win32"` 回退为 `>`，其他平台保持 `❯`。
- 只改共享符号，不动列表布局、不引入 `figures` 依赖、不改面板状态逻辑。
- 不新增 `TICK` 等尚未被引用的符号；面板内的硬编码符号留待各自收敛到共享符号时处理。

## 修复

`theme.ts` 的 `POINTER` 改为平台判断，测试断言改用导入的 `POINTER`，避免在测试里硬编码字符。

## 曾考虑的替代方案

- **直接依赖 `figures` 包。** 与 Claude Code 行为最接近，但当前只需要一个符号；为 36KB 依赖引入终端能力探测收益不足，先用显式平台回退。
- **所有平台统一用 ASCII `>`。** 最简单且最兼容，但会降低 macOS/Linux 终端里的视觉一致性，因此只对 Windows 回退。
- **同时引入 `TICK` 并改 `SessionsPanel` 勾选标记。** 舍弃。会话列表已按对齐方案移除当前会话标记，引入的 `TICK` 没有调用方，属于死代码。

## 后果与防回退

- Windows 上聚焦指针显示为 `>`；其他平台保持 `❯`。
- `ModelPicker`、`ModelSetupPanel` 仍硬编码 `❯` / `✓`，在缺字形的终端上依旧可能不可见；收敛这些面板时需要复用 `POINTER` 与同一平台回退。
- 新增 Unicode 符号时跨终端兼容性问题会重复出现；跨终端符号应集中放在 `theme.ts`，不要在各面板硬编码。
- 回归测试必须断言聚焦行包含 `POINTER`，不得写死 `❯`。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/app/tui.render.test.tsx`：通过。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm exec biome check apps/cli/src/tui/chrome/theme.ts apps/cli/test/tui/app/tui.render.test.tsx`：通过。
- 需要在 Windows `cmd.exe` / Windows Terminal 中手动打开列表与输入框，确认聚焦行显示 `>`。
