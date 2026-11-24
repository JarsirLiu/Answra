# Note：CLI TUI 渲染 Markdown 表格

状态：已实施

## 问题

模型经常以 GFM 表格回答对比、参数或步骤清单，但 CLI transcript 只做行内样式与代码围栏处理，`| a | b |` 与 `| --- | --- |` 原样打印成三行竖线文本。用户在终端里读不到列结构，也无法判断表头与单元格的对应关系。项目以复刻 Claude Code 的 UI 为目标，而 Claude Code 会把表格画成带边框的盒子。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/transcript/markdown/blocks.ts`：Markdown 分块（代码围栏、表格、普通行）。
  - `apps/cli/src/tui/transcript/markdown/table.ts`：GFM 表格解析、列宽分配、单元格折行、竖排降级与边框绘制。
  - `apps/cli/src/tui/transcript/markdown/inline.tsx`：原 `inline()` 行内投影，迁入 markdown 子目录。
  - `apps/cli/src/tui/transcript/markdown/MarkdownText.tsx`：渲染入口；表格按视口列宽布局。
  - `apps/cli/src/tui/transcript/markdown/columns.ts`：transcript 列宽 context，避免每个 Markdown 块各自订阅 resize。
  - `apps/cli/src/tui/app/App.tsx`、`apps/cli/src/tui/transcript/{Transcript,VirtualTranscript}.tsx`：在自己的视口测量列宽并注入 context。
  - `apps/cli/src/tui/transcript/virtualLayout.ts`：`countMarkdownLines` 按真实表格/代码行数估算虚拟高度。
- UI 表面：仅 CLI transcript 的 assistant/user 文本投影；不改变桌面端 Markdown 渲染、Agent 输出或持久化格式。
- 相关 Note：
  - [CLI TUI assistant 内容块间距对称化](../bug-fix/2026-11-20-cli-assistant-block-spacing.md)
  - [CLI 重试提示缺少原因与倒计时](../bug-fix/2026-11-16-cli-retry-notice-visibility.md)

## 决定

- 不引入 `marked`。现有解析器是手写行/代码围栏分类，表格只需在块级增加一种块类型；引入完整 Markdown 解析器会同时改变既有标题、列表、链接行为，超出本次范围。
- 表格解析只接受标准 GFM 形态：表头行、分隔行（`---`、`:---`、`---:`、`:---:`）与连续数据行；分隔行列数与表头一致才算表格，避免把正文里的 `|` 误判成表格。
- 布局与 Claude Code 的 `MarkdownTable` 对齐：
  - 列宽先满足每列“最长不可断词”宽度，再按溢出比例分配剩余列宽；CJK 与空格视为可断行点。
  - 表头居中，数据行按分隔行对齐；表头后固定一条 `├─┼─┤` 分隔线。
  - 单元格按显示宽度折行，最多 4 行；超过 4 行或最小列宽总和放不下时降级为 `标题: 值` 竖排键值格式，避免窄终端把表格挤成不可读的碎片。
  - 表格宽度取 `终端列数 - 4`（`TABLE_SAFETY_MARGIN`），给父级缩进和 resize 竞态留余量。
- 表格与代码块共享 `marginY={1}`；虚拟高度估算必须使用同一布局函数，不能按原始行数估算。
- transcript 列宽由视口通过 `MarkdownColumnsContext` 注入一次；`MarkdownText` 在没有 provider 时退回自身 `useWindowSize()`，保证独立渲染仍可用。

## 影响表面

- assistant 与 user 消息里的 GFM 表格显示为 `┌┬┐` 边框、居中表头与对齐单元格；窄终端自动改成竖排键值。
- 表格的单元格文本不保留粗体、内联代码等行内样式，只保留可读文本，避免折行后残留半截标记。
- 虚拟列表的滚动高度按表格实际渲染行数计算，长表格不会出现行高跳动或底部跟随错位。
- 围栏代码块中的 `|` 仍按代码原样输出，不进入表格解析。

## 曾考虑的替代方案

- **引入 `marked` 只解析表格：** 舍弃。会新增依赖并把表格 token 化的同时保留另一套手写行解析，形成两种解析事实源；维护成本高于本次增量的块解析。
- **保留竖线原文，仅做等宽对齐：** 舍弃。没有表头分隔和边框，窄终端下仍然无法判断列边界，也不符合 Claude Code 的视觉。
- **直接用 Ink 的 `Box` 拼表格而不是绘制字符边框：** 舍弃。多行单元格与对齐需要逐行字符串布局；用字符边框还能让高度估算与渲染共享同一份行数组。
- **把表格渲染放进 `@answra/ui` 共享：** 舍弃。桌面使用 DOM 渲染，本表格是终端字符布局，属于 CLI 宿主投影，放入共享包会引入 Ink/DOM 无关的终端假设。

## 后果与防回退

- 表格布局的唯一实现是 `layoutMarkdownTable`；渲染与 `countMarkdownLines` 必须同时使用它，新增表格样式（如列宽上限）不得只在渲染侧修改。
- 表格单元格折行按 `string-width` 计算，禁止改回 `text.length`，否则 CJK 列宽会溢出。
- 表格降级阈值（最小列宽、单行 4 行、`TABLE_SAFETY_MARGIN`）是防闪烁与可读性的边界；放宽前必须在 40/60/80 列下实机确认不会触发 Ink 行内换行。
- `MarkdownColumnsContext` 缺席时允许逐块订阅 resize，但 transcript 根必须在 `VirtualTranscript`/`Transcript` 注入列宽，避免长会话超出 stdout listener 上限。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/transcript test/tui/app`：17 个文件、91 项通过；覆盖表格解析、边框/对齐/CJK 宽度、竖排降级、代码围栏不被误判、表格高度估算与 transcript 渲染。
- `pnpm exec biome check apps/cli/src/tui/transcript apps/cli/test/tui/transcript`：通过。
- `apps/cli` typecheck 通过（`apps/agent` 同期存在与本变更无关的未提交改动，见提交说明）。

## 风险

- 极窄终端或超长单词列会降级为竖排格式，信息仍完整但视觉不再是表格；这是有意的可读性取舍。
- 行内样式不进入单元格，链接只显示链接文字，复制表格时拿不到 URL。
- 表格高度估算依赖 `useWindowSize()` 的列数与渲染时一致；若宿主另行裁剪宽度，估算可能偏小，最终以实测高度回填。
