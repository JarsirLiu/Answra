# Note：CLI slash 命令候选与 Tab 补全

状态：已实施

## 问题

CLI TUI 已有 `/help`、`/clear`、`/model`、`/exit` 四个本地 slash 命令，但初版实现中命令名、解析分支和帮助文案分散：

- 用户必须记住完整命令名；输入 `/mo` 后按 Enter 只会得到“未知命令”。
- `/help` 能列出命令，但输入 `/` 时没有任何候选、选中态或补全入口。
- 命令名、别名、帮助文案和解析分支分散，新增命令容易只改一处，造成帮助与行为漂移。
- 运行中按 Esc 取消 run 与关闭命令面板会争用同一个按键，如果不显式协调，关闭面板会误取消正在执行的任务。
- 后续收口发现：catalog 只统一了元数据，新增命令仍要同时改 `catalog.ts`、`parse.ts` 和 `runTui.tsx`，不是真正的“一个命令一个维护点”。

本次补齐内置命令的展示与补全，并把命令身份、解析和执行注册收口到 catalog + dispatcher；不引入自定义命令目录、`$ARGUMENTS` 展开或 Agent 自动调用 skill。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/commands/catalog.ts`：内置命令唯一元数据来源、别名、帮助用法、前缀过滤与补全纯函数。
  - `apps/cli/src/tui/commands/CommandPalette.tsx`：候选列表投影与选中态。
  - `apps/cli/src/tui/commands/parse.ts`：把文本解析为 catalog spec + 参数，不执行命令。
  - `apps/cli/src/tui/commands/dispatch.ts`：按 catalog kind 注册并分派 handler，集中命令错误处理。
  - `apps/cli/src/tui/commands/help.ts`：按 catalog 生成命令用法与对齐，不再维护独立命令名单。
  - `apps/cli/src/tui/composer/PromptInput.tsx`：`/` 前缀检测、Tab 补全、Up/Down 选择、Esc 关闭、Enter 先补全前缀。
  - `apps/cli/src/tui/app/App.tsx`：接收面板开关状态；面板打开时 Esc 不触发取消 run 或清除选区。
  - `apps/cli/test/commands.test.ts`、`apps/cli/test/runTui.test.ts`、`apps/cli/test/tui.test.tsx`：目录过滤、补全、分派与 TUI 按键行为测试。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；不触达 Agent 事件、transcript 投影、IPC、持久化或 desktop。
  - 不新建 `packages/tui`；仍使用 `ink@8.0.0` 与 React 19.3。
- 相关 Note：
  - [CLI Coding 模式与终端 UI（TUI）移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [CLI 输入光标导航与对话鼠标选区](2026-11-13-cli-input-navigation-and-transcript-selection.md)
  - [CLI 模型设置域](../architecture/2026-11-13-cli-model-settings-domain.md)

## 影响表面

- 输入框：输入 `/` 或命令前缀时，上方出现候选面板；`Up/Down` 选择，`Tab` 补全，`Enter` 在只输入前缀时先补全，`Esc` 关闭面板。
- 帮助：`/help` 的命令行由 catalog 生成，覆盖 `/help`、`/clear`、`/model` 的显示/切换/添加用法和 `/exit`，并提示输入 `/` 查看命令、Tab 补全。
- 运行态：面板打开时按 Esc 只关闭面板，不取消正在执行的 run，也不清除 transcript 选区。
- 解析：`/quit` 仍映射到 `/exit`；未知命令仍返回未知命令提示；`/model qwen` 等带参数输入不显示顶层候选。
- 维护：新增命令只改 catalog、handler 与 dispatcher 注册；修改命令行为只改对应 handler；不触碰输入框或 TUI 根布局。

## 决定

### 1. 单一命令目录

`catalog.ts` 是内置命令的唯一元数据来源：

```ts
interface TuiCommandSpec {
  kind: "help" | "clear" | "exit" | "model";
  name: string;
  aliases?: readonly string[];
  summary: string;
  argumentHint?: string;
  helpUsage?: string;
  helpDetails?: readonly TuiCommandHelpDetail[];
}
```

- `parseTuiCommand` 返回 `{ command: TuiCommandSpec; args }` 或 `{ name }`，不再维护第二套 `TuiCommand` union 与 switch。
- `suggestTuiCommands(prefix)` 按主名称或别名前缀过滤；`completeTuiCommand` 对需要参数的命令补一个尾随空格，对无参数命令只补命令名。
- `tuiCommandPrefix` 只在输入以 `/` 开头且尚未出现空白时返回前缀；`/model qwen` 不再显示顶层候选。
- 补全使用主名称，例如输入 `/qu` 会补成 `/exit`，不会保留别名。

### 2. 命令执行注册

`dispatch.ts` 把执行从 TUI 组合根移出：

```ts
const handlers = {
  help: handleHelp,
  clear: handleClear,
  exit: handleExit,
  model: handleModel,
} satisfies Record<TuiCommandKind, TuiCommandHandler>;
```

- `runTui.tsx` 只解析、调用 `dispatchTuiCommand`，不再按 kind 写 switch。
- `satisfies Record<TuiCommandKind, ...>` 让新增 kind 在缺少 handler 时直接 typecheck 失败。
- 命令错误统一由 dispatcher 转成 `store.fail`，handler 只表达成功路径或抛出用户可读错误。
- 新增本地命令的维护点是：catalog 加一条、handler 加实现、dispatcher 注册一行；不需要改 `PromptInput`、`App` 或 `runTui` 的分支。
- 如果新命令需要新的会话能力，只新增一个 `CodingSession`/Agent 端口方法，再由 handler 调用；不复制整条 TUI 或后端链路。

### 3. 输入框交互

- 输入 `/` 或继续输入命令前缀时，在输入框上方显示候选面板；主名称、用法和摘要同屏。
- `Up/Down` 在候选面板打开时移动选中项，不移动输入光标或浏览历史；面板关闭后恢复原有行为。
- `Tab` 补全当前选中命令并关闭面板；面板被 Esc 关闭后，Tab 重新打开候选。
- `Enter` 在候选面板打开且当前输入只是前缀时，先补全命令、不提交；输入已经是完整命令时，再按 Enter 才提交。这样避免 `/` + Enter 直接执行第一个候选。
- `Esc` 只关闭候选面板；面板打开期间 App 不把同一次 Esc 解释为取消 run 或清除选区。

### 4. 帮助生成

- `help.ts` 用 `tuiCommandHelpUsage()` 生成每个命令的首行用法，用 `string-width` 对齐摘要。
- `helpDetails` 只保存额外用法和说明，例如 `/model <ID>` 与 `/model add ...`；命令名和首行用法不再手写。
- 新增或改名命令时，帮助页不会出现与 catalog 不一致的第二份命令名。

### 5. 明确不做

- 不加入 `.answra/commands` 或用户目录自定义命令。
- 不展开 `$ARGUMENTS`、命名参数或 shell 参数。
- 不提供模型可调用的 Skill tool，也不让 Agent 自动推荐命令。
- 不做 `/model add` 等子命令的二级补全；输入空格后关闭顶层候选。

## 曾考虑的替代方案

- **把命令列表继续硬编码在 `PromptInput`：** 舍弃。输入框会同时拥有命令语义、帮助文案和补全规则，新增命令必须改多个文件；目录纯函数更容易测试。
- **只做 Tab 补全，不显示候选列表：** 舍弃。用户看不到有哪些命令、当前选中哪个，也无法用 Up/Down 选择；不满足“输入 `/` 唤出命令”的目标。
- **Tab 循环切换候选而不补全：** 舍弃。用户仍要再按 Enter 才能看到完整命令；Tab 直接补全是终端里更常见的预期。
- **`/` + Enter 直接执行第一个候选：** 舍弃。用户只想打开面板时容易误执行 `/help` 或 `/model`；先补全、再确认更安全。
- **保留 `TuiCommand` 第二套 union 和 `parse.ts` switch：** 舍弃。新增 kind 时 TypeScript 不一定报错，命令可能静默落成普通 prompt；parse 应只返回 catalog spec。
- **把 help/clear/exit 继续写在 `runTui.tsx`：** 舍弃。组合根会继续承载命令产品策略，团队并行时新增命令都改同一个文件；handler registry 更稳定。
- **本轮同时做自定义命令与 `$ARGUMENTS`：** 舍弃。需要文件发现、frontmatter 解析、参数替换、权限与错误处理，属于独立能力；先让内置命令可发现、可补全、可稳定注册。
- **引入通用命令框架：** 舍弃。当前只有四个本地命令，catalog 表加 handler registry 足够；框架会扩大启动路径和测试成本。

## 后果与防回退

- 新增本地命令必须同时进入 `catalog.ts` 的 `TUI_COMMANDS` 和 `dispatch.ts` 的 handler registry；`satisfies` 负责编译期完整性。
- `parse.ts` 与 `help.ts` 不得恢复独立命令名单或第二套 union；帮助首行必须继续由 catalog 生成。
- `runTui.tsx` 不得重新加入按命令 kind 的 switch；命令产品策略留在 `commands/`。
- 面板打开时 Esc 的归属必须保持“先关面板、不取消 run”；App 的 Esc 处理必须继续检查面板开关。
- 自定义命令、模型调用 Skill 与二级补全仍是后续能力；本次不得在文档或 UI 中声称已支持。
- 候选面板最多显示 6 项，超出时围绕选中项滚动；新增大量命令时仍需保持单屏可读。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/commands.test.ts test/runTui.test.ts test/tui.test.tsx`：50 项通过，覆盖目录过滤、补全、未知命令、运行中拒绝清除、`/` 候选、Tab 补全、Up/Down 选择、Enter 前缀补全、Esc 关闭后 Tab 重开、运行中 Esc 不取消。
- `pnpm --filter @answra/cli test`：25 个测试文件、182 项通过。
- `pnpm exec biome check`：本次改动文件通过。
- 需要的实机验证：在 VS Code 集成终端或 Windows Terminal 中确认 `/` 面板不遮挡输入、Tab 补全后光标位置正确、中文摘要不折行错位；自动化测试只证明渲染与按键分支。
