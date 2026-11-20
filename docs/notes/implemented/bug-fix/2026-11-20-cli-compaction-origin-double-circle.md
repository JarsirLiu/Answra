# Note：Windows 下压缩摘要折叠态出现两个蓝色圆点和孤立圆点行

状态：已实施

## 问题

自动压缩成功后，CLI TUI 的折叠摘要显示成两行：第一行 `Compact summary (ctrl+o to expand)` 前有一个蓝色圆点，第二行又出现一个没有内容的同款圆点。用户反馈“俩圆球好难看”，且 Claude Code 在 Windows 上不会出现这种蓝色圆点。

问题由两个独立缺陷叠加：

1. 折叠态无元数据分支把空的 `MessageResponse` 容器也渲染出来，容器左侧的圆点没有内容可承载，形成孤立圆点行。
2. `BLACK_CIRCLE` 固定为 `⏺`（U+23FA）；Windows 控制台字体把它渲染成蓝色录制按钮图标，而 Claude Code 只在 macOS 使用该字形，Windows/Linux 回退为实心小圆点。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/chrome/theme.ts`、`apps/cli/src/tui/transcript/CompactionBoundaryRow.tsx`、`apps/cli/src/tui/transcript/Transcript.tsx`
- UI/进程/协议/持久化表面：CLI TUI transcript 的压缩摘要块、消息/工具行左侧圆点、欢迎页标题
- 相关 Note：`docs/notes/implemented/bug-fix/2026-11-19-cli-windows-tui-symbols.md`、`docs/notes/proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md`、`docs/notes/implemented/feature/2026-11-14-manual-compaction-instructions-and-summary.md`

## 根因

- `CompactionBoundaryRow` 用 `expanded ? MessageResponse(summary) : MessageResponse(collapsedBody)` 统一渲染正文；无元数据分支的 `collapsedBody` 为 `null`，`MessageResponse` 仍固定渲染左侧圆点，导致折叠态多出一个空圆点行。
- `theme.ts` 的 `BLACK_CIRCLE` 没有平台判断；U+23FA 在 Windows 终端字体中显示为彩色录制图标，与 Claude Code 的终端观感不一致。

## 决定

- 压缩摘要折叠态用 Claude Code 的 `CompactSummary` 结构：标题行单独持有圆点，正文只在展开时渲染。
- `BLACK_CIRCLE` 由 `theme.ts` 统一做平台回退，Windows 用 `●`、其他平台用 `⏺`。
- 不在 `MessageResponse` 上增加“隐藏圆点”开关，也允许标题行与展开正文各有一个圆点。

## 修复

- `CompactionBoundaryRow` 对齐 Claude Code 的 `CompactSummary` 结构：标题行单独渲染圆点与标题；正文只在展开时用 `MessageResponse` 渲染摘要，无元数据折叠态不再渲染正文容器。带元数据分支保持原来的 `MessageResponse` 行（条数、Context、展开提示）。
- `BLACK_CIRCLE` 按 `process.platform === "win32"` 回退为 `●`，其他平台保持 `⏺`。
- 欢迎页标题改用 `BLACK_CIRCLE`，不再硬编码字形。

## 曾考虑的替代方案

- **只删掉无元数据分支的空 `MessageResponse`，不改字形。** 能消除孤立圆点，但 Windows 上仍显示蓝色录制图标，用户明确要求复刻 Claude Code 的观感，因此同时做平台回退。
- **所有平台统一改成 `●`。** 最省事，但会丢失 macOS 上与 Claude Code 一致的 `⏺` 字形，因此只对 Windows 回退。
- **让 `MessageResponse` 支持“无圆点”模式。** 会扩大共享原语的状态面，而真正的问题是折叠态不应渲染正文容器，故不引入额外开关。

## 后果与防回退

- Windows 上所有消息、工具、压缩摘要的圆点变为 `●`；macOS/Linux 保持 `⏺`。
- 无元数据压缩边界折叠态只有标题行一个圆点；展开后标题行与摘要正文各一个圆点（与 Claude Code transcript 模式一致）。
- 回归测试断言折叠态只出现 1 个 `BLACK_CIRCLE`、展开态出现 2 个，且字符从 `theme.ts` 导入，不得写死字形。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/app/tui.compaction.test.tsx`：通过（含新增圆点计数断言）。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm exec biome check apps/cli/src/tui/chrome/theme.ts apps/cli/src/tui/transcript/CompactionBoundaryRow.tsx apps/cli/src/tui/transcript/Transcript.tsx apps/cli/test/tui/app/tui.compaction.test.tsx`：通过。
- `test/tui` 全量中 `sessionsPanel.test.tsx` 的宽字符标题断言在 HEAD 上已失败，与本次改动无关。
- 需要在 Windows Terminal 中手动确认压缩摘要折叠/展开后的圆点数量与字形。
