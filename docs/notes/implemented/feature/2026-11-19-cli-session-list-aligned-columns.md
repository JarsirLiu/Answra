# Note：CLI 历史会话列表对齐

状态：已实施

## 问题

CLI `/sessions` 列表把“当前会话”标记和短 ID、时间、标题混排，导致行首列宽不统一，时间及标题会在不同终端宽度下错位。当前会话标记对恢复选择没有帮助，焦点状态才是用户需要辨认的对象。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/panels/SessionsPanel.tsx`
- 测试：`apps/cli/test/tui/panels/sessionsPanel.test.tsx`
- UI 表面：CLI TUI `/sessions` 历史会话面板；不改变会话存储或删除当前活动会话后的控制器行为。

## 决定

- 列表行只显示焦点指针、固定宽度短 ID、固定格式时间戳和单行截断标题。
- 移除“当前会话”勾选/文字标记，不根据活动会话 ID 自动移动初始焦点；列表顺序仍由会话目录返回。
- 列间宽度按固定字段预算计算，标题使用剩余终端列宽截断，窄终端至少保留一列标题空间。
- 当前活动会话仍由既有删除用例识别；删除它仍关闭面板。

## 影响表面

- `/sessions` 初始焦点落在第一条会话；所有行的 ID、时间和标题起始列一致。
- 标题不会折行；终端变窄时只缩短标题，不推动固定字段换列。
- 当前会话不再额外标记；键盘焦点仍由箭头、颜色和粗体显示。

## 曾考虑的替代方案

- **保留当前会话标记并调色：** 舍弃。它占用首列并与焦点选择混淆，用户明确不需要该信息。
- **使用终端 Tab 对齐：** 舍弃。Tab 展开宽度取决于终端设置，无法提供稳定列位置。
- **标题换行显示：** 舍弃。换行会打断列表逐行扫描，标题应截断在当前行。

## 后果与防回退

- 初始焦点固定在第一条会话，方向键和翻页只改变焦点，不受活动会话位置影响。
- 列表视觉上不再区分活动会话；恢复和删除仍按完整 conversation ID 操作。
- 回归测试需覆盖活动会话标记缺席、日期和标题列对齐，以及长标题保持单行。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/panels/sessionsPanel.test.tsx`：11 项通过；覆盖无当前会话标记、焦点指针和固定列对齐。
- `pnpm exec biome check apps/cli/src/tui/panels/SessionsPanel.tsx apps/cli/test/tui/panels/sessionsPanel.test.tsx`：通过。
- `pnpm notes:check`：通过。
