# Note：CLI TUI 命令候选与参数提示 UI

状态：已实施

## 问题

CLI TUI 的 slash 命令提示已经能列出候选、用 Tab 补全、用 Enter 执行，但视觉和检索能力与 Claude Code 仍有差距：

- 候选面板命令用法列宽随内容变化，描述起始位置不对齐，窄终端下容易杂乱。
- 只做大小写无关的前缀/别名过滤，不支持精确名优先或描述匹配；命令变多后查找成本会上升。
- 选中 `/compact`、`/resume` 等带参数命令后，没有显示参数提示；`TuiCommandSpec.argumentHint` 只用于补全时追加空格。
- 没有最近使用排序，也没有输入框下方的 footer 提示层。

用户希望参考 `D:\codespace\Claude-Code` 的命令提示 UI，同时明确要求实现越简单、越灵活可用越好。参考目录是外部实现，只借鉴交互和视觉原则，不复制其代码、skills/plugin 分类或依赖。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/commands/catalog.ts`：命令元数据、候选排序与参数提示纯函数。
  - `apps/cli/src/tui/commands/CommandPalette.tsx`：候选行布局、截断、选中态和最大可见行数。
  - `apps/cli/src/tui/commands/paletteLayout.ts`：候选行显示宽度、截断与补齐。
  - `apps/cli/src/tui/composer/PromptInput.tsx`：参数提示行、会话内最近使用和候选面板接线。
  - `apps/cli/src/tui/composer/useTuiCommandHints.ts`：候选、参数提示与会话内最近使用的组合 hook。
  - `apps/cli/test/tui/commands/*`、`apps/cli/test/tui/composer/*`：纯函数与组件测试。
- UI/进程/协议/持久化表面：只改 CLI TUI 的命令提示；不改命令执行、Agent 事件、模型配置、远程协议或桌面端。
- 不涉及：新增 npm 依赖、持久化最近使用、跨客户端命令目录、Claude Code 的 skills/plugins/MCP 分类。
- 相关 Note：
  - [CLI slash 命令候选面板](./2026-11-13-cli-slash-command-palette.md)
  - [CLI TUI UI 目录架构](../architecture/2026-11-14-cli-tui-ui-directory-architecture.md)
  - [CLI 斜杠命令统一管理远程连接](../../proposed/feature/2026-11-15-cli-slash-remote-management.md)

## 决定

### 1. 候选面板保留在输入框上方

不移动 `CommandPalette` 的位置。当前上方展开的实现更简单，不需要调整 `App` 的 transcript/composer/status 高度分配；用户也明确接受“候选面板不必出现在输入框下面”。

面板最多显示 5 行，避免挤压短终端；选中行仍保留 `POINTER`，保证无颜色终端也能识别当前选择。

### 2. 稳定列宽与描述截断

`CommandPalette` 按当前候选集计算命令用法列宽：

- 用 `string-width` 计算宽字符显示宽度。
- 列宽上限为可用宽度的 40%，最低 12 列；窄终端下继续压缩。
- 命令用法先截断再补齐到同一列宽，描述从固定列开始。
- 描述按剩余宽度截断，超出部分用 `…`，不换行、不越界。
- 选中行使用 `TUI_THEME.suggestion`，描述不再 dim；未选中行保持 dim 描述。

### 3. 参数提示先用独立提示行

新增 `tuiCommandArgumentHint(value)`：

- 只在输入以 `/` 开头时生效。
- 命令名后没有空格，或只有恰好一个尾随空格时，返回精确匹配命令的 `argumentHint`。
- 已有真实参数时不显示。
- 未知命令、非命令输入返回 `undefined`。

`PromptInput` 只在光标位于输入末尾、没有选区、`showHints` 开启时，把提示渲染为输入框下方一行 dim 文本。提示不进入 `TextInput` 的值，也不改 `layoutInput`/`useCursor`，避免影响宽字符换行、光标列和多行滚动。

### 4. 精确优先的排序与会话内最近使用

`suggestTuiCommands(query, recentNames)` 的排序规则：

1. 精确命令名。
2. 精确别名。
3. 命令名前缀。
4. 别名前缀。
5. 命令描述包含查询词。
6. 其余保持 catalog 顺序。

输入只有 `/` 时，最近执行过的命令（最多 3 个，去重）排在最前，其余按 catalog 顺序。最近使用只存在 `PromptInput` 的会话内状态，不写入 config、不跨进程持久化。命令在成功提交时记录，别名归一到 canonical name。

不引入 Fuse.js；当前命令只有 14 个，简单评分足够。

### 5. 暂不实现的部分

- 不移动候选面板到输入框下方。
- 不做 inline argument hint；独立提示行已经覆盖主要收益。
- 不做输入中间 `/com` 的 ghost text。
- 不显示 `? for shortcuts` 或完整快捷键菜单；当前没有对应 help overlay。
- 不复制 Claude Code 的 skills/plugins/MCP 分类和多来源 suggestion。

## 影响表面

- TUI 候选面板仍从输入框上方展开，最多 5 行。
- 候选行对齐、描述截断和选中态更稳定；窄终端不横向溢出。
- 带参数命令在未输入参数时显示独立提示行。
- `/` 候选加入会话内最近使用；命令执行语义不变。
- 不新增依赖、不新增持久化字段、不改桌面端和 Agent 协议。

## 曾考虑的替代方案

- **完整移植 Claude Code 的 `useTypeahead` + Fuse.js：** 舍弃。Claude Code 需要处理文件、MCP、agent、shell、skills 多类 suggestion，Answra 只有 14 个静态命令；直接移植会引入依赖和与现有 `PromptInput` 状态重复的第二套 typeahead。
- **把候选面板移到输入框下方：** 舍弃。虽然更接近 Claude Code footer，但需要重新分配 transcript/composer/status 高度；用户明确接受保留上方，先用更简单的布局拿到主要内容收益。
- **第一版就做 inline argument hint：** 舍弃。`TextInput` 按值布局并单独计算光标，提示文本参与换行会牵动宽字符、选区和多行滚动；独立提示行风险更低。
- **把最近使用持久化到共享 config：** 舍弃。会跨客户端写入非模型配置，且当前没有“命令使用记录”契约；会话内排序已足够。
- **直接显示 `? for shortcuts`：** 舍弃。没有对应 help overlay 时只是装饰。
- **保留固定 6 行候选：** 舍弃。5 行更接近 Claude Code footer，也给短终端和状态行留出空间。

## 后果与防回退

- 候选面板位置仍是输入框上方；如果未来要改 footer 布局，必须单独处理 `App` 高度分配和短终端验收，不能只移动组件。
- 参数提示是独立行，不是 inline 文本；若未来合并到 `TextInput`，必须重新验证光标位置、宽字符换行和多行滚动。
- 最近使用只存在于当前 `PromptInput` 生命周期；不要把它误写成持久化排序，也不要让 `/` 的默认顺序依赖上一次进程。
- 排序必须保持“精确名 > 前缀 > 描述”的优先级；否则用户输入完整命令名时可能被描述匹配挤到后面。
- 命令列宽上限是 40% 可用宽度；窄终端下命令用法会被截断，必须保留可区分的命令名前缀。

## 验收标准

- 可观察结果：
  - 输入 `/` 时候选出现在输入框上方，最多 5 行，描述列对齐，选中行颜色/指针清晰。
  - 输入 `/co` 时 `compact`、`config` 按前缀优先排序；输入完整命令名时精确匹配排第一。
  - 输入 `/compact` 或 `/compact ` 时显示 `[instructions]` 提示；输入 `/compact 保留迁移` 后提示消失。
  - 输入 `/resume` 或 `/resume ` 时显示 `<ID|前缀>` 提示。
  - Tab 补全、Enter 执行、Esc 关闭、上下键选择行为不变。
  - 窄终端（例如 24 列）下候选行不换行、不越界。
  - 执行 `/model` 后再输入 `/`，`model` 排在候选最前。
- 自动化验证：
  - `apps/cli/test/tui/commands/commands.test.ts` 覆盖排序、别名、参数提示、最近使用和未知命令。
  - `apps/cli/test/tui/commands/commandPalette.test.tsx` 覆盖行对齐、最大可见数、选中态和窄宽度截断。
  - `apps/cli/test/tui/composer/tui.composer.test.tsx` 覆盖参数提示出现/消失、最近使用排序与 Tab/Enter 行为。

## 验证

- 2026-11-17：`apps/cli/test/tui/commands/commands.test.ts` 11 项、`commandPalette.test.tsx` 5 项、`tui.composer.test.tsx` 17 项通过。
- 2026-11-17：完整 `@answra/cli` 测试 51 个文件、319 项通过；`pnpm typecheck` 全 workspace 通过。
- 2026-11-17：`pnpm lint`、`pnpm architecture:check` 与 `pnpm notes:check` 通过。
- 未做真机截图验收；候选面板颜色对比度与 24/120 列终端表现需要在后续手动检查。
