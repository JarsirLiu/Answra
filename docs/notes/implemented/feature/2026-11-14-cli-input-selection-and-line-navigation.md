# Note：CLI 输入框全选、剪切与单行上下移动

状态：已实施

## 问题

CLI 输入框只有插入点，没有选区：`Ctrl+A` 被当作 emacs 行首，用户无法一次选中整段输入再剪切或覆盖；单行输入按 `↑/↓` 会立即回退到历史，无法像常见编辑器那样先到整段开头/末尾，导致长单行 prompt 的编辑成本高。

对照 Claude Code 参考实现后确认：参考实现也没有输入框全选/剪切，`Ctrl+A` 是行首，`↑/↓` 在首/末行直接进入历史。本仓库按用户明确要求提供更接近常见编辑器的输入体验，而不是逐键复刻参考。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/composer/selection.ts`（新增）：输入框选区的纯函数，归一化锚点/插入点、取选中文本、删除选区；与 `interaction/selection.ts` 的对话区鼠标选区无关。
  - `apps/cli/src/tui/composer/PromptInput.tsx`：`Draft` 增加 `anchor`；`Ctrl+A` 全选、`Ctrl+X` 剪切、输入/删除/退格替换选区、左右键折叠选区、`Ctrl+U/K/W` 优先删除选区；单行 `↑/↓` 先到整段首/尾，已在边界才浏览历史。
  - `apps/cli/src/tui/composer/TextInput.tsx`：按 token 偏移渲染反色选区；有选区时不再绘制单字符假光标。
  - `apps/cli/src/tui/composer/inputLayout.ts`：新增 `inputVisualLineCount`，区分单行与软换行/多行。
  - `apps/cli/src/tui/app/App.tsx`、`runTui.tsx`：把共享 `ClipboardWriter` 注入 `PromptInput`，输入剪切复用对话区复制的 OSC 52 + 本地命令兜底。
  - `apps/cli/test/inputSelection.test.ts`（新增）、`inputLayout.test.ts`、`tui.test.tsx`：选区纯函数、行数、全选/剪切/替换/单行上下移动/历史回退。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端输入框；不改 Agent 事件、transcript、IPC 或持久化。
  - 剪切写系统剪贴板只发生在用户按 `Ctrl+X` 且有选区时；`--no-alt-screen` 仍不接管终端原生鼠标选择。
  - secret 输入（API Key）不建立选区、不响应全选/剪切，避免把密钥写入剪贴板。
- 相关 Note：
  - [CLI 输入光标导航与对话鼠标选区（对齐 Claude Code）](2026-11-13-cli-input-navigation-and-transcript-selection.md)
  - [CLI 启动引导中的 API Key 输入](2026-11-13-cli-onboarding-api-key-input.md)

## 影响表面

- `Ctrl+A` 从“到行首”改为“全选输入内容”；`Home` 仍到当前显示行行首，`End`/`Ctrl+E` 仍到行尾。
- 有选区时：直接输入、粘贴、退格、`Delete`、`Ctrl+U/K/W` 都先删除选区；`←/→` 折叠到选区起点/终点；`Ctrl+X` 复制并删除。
- 单视觉行输入：`↑` 先到整段开头，已在开头才回退历史；`↓` 先到整段末尾，已在末尾才前进历史。窄列宽导致的软换行按多视觉行处理。
- 多行输入保持原行为：`↑/↓` 先在显示行之间移动，没有相邻显示行才浏览历史。
- 选区只影响输入框渲染；对话区鼠标选区与复制快捷键不变。

## 决定

1. **选区以 `(anchor, cursor)` 表达。** 锚点是全选起点或后续扩展预留；当前只有 `Ctrl+A` 产生选区，左右移动会折叠选区。
2. **`Ctrl+A` 全选，`Ctrl+X` 剪切。** `Home`/`End`/`Ctrl+E` 保留行级导航；不再用 `Ctrl+A` 充当行首。
3. **剪切复用 `ClipboardWriter`。** `runTui` 始终创建 writer（不再仅 alt-screen），输入框与对话区选区共用 OSC 52 + 本地兜底；只有显式剪切才写入，`--no-alt-screen` 不启用鼠标 tracking。
4. **编辑操作先消费选区。** 输入、粘贴、退格、`Delete`、`Ctrl+U/K/W` 在存在选区时只删除选区，不叠加词/行删除语义。
5. **单行上下键优先段首/段尾。** 用 `inputVisualLineCount` 判断视觉行数；多行与软换行输入仍按显示行移动。这样保留历史浏览：只有在段首按 `↑`、段尾按 `↓` 才浏览历史。
6. **secret 输入显式禁用。** 全选、剪切、选区渲染都对 `secret` 关闭；密钥不会因为剪切进入系统剪贴板。

## 曾考虑的替代方案

- **保留 `Ctrl+A` 为行首，另设全选键（如 `Ctrl+Shift+A`）：** 舍弃。用户明确要求 `Ctrl+A` 全选；`Home` 已覆盖行首语义，保留双绑定会让终端拦截差异更不可预测。
- **剪切只删除不写剪贴板：** 舍弃。用户要的是“剪切”，并且仓库已有可复用的 `ClipboardWriter`。
- **为输入框单独创建 clipboard writer：** 舍弃。writer 无状态，重复创建只会增加两条写入路径；共享同一实现便于测试和替换。
- **引入 Shift+方向键扩展选区、鼠标拖选输入框：** 本次不做。当前需求是全选/剪切；扩展选区需要新的锚点移动、点击命中和指针坐标接入，留待独立 Note。
- **单行 `↑/↓` 继续直接回退历史：** 舍弃。长单行 prompt 无法先回到开头/末尾，正是本次要解决的问题；历史仍可在边界触发。

## 后果与防回退

- `Ctrl+A` 的语义变化是用户可见行为变更；帮助文案、Note 与测试必须同步，不能同时保留“Ctrl+A 行首”的旧描述。
- 输入选区状态只能存在于 `PromptInput` 的 `Draft`；不得写进 `TuiViewStore`、Agent 事件或持久化文件。
- 剪切必须走 `onCopyText` 端口，组件不得直接 import `node:child_process` 或自行拼 OSC 52。
- `secret` 输入一旦启用选区，必须作为安全缺陷修复；不得以“方便编辑”为由放开。
- 单行上下键的边界判断必须使用 `inputVisualLineCount`，不能只看 `value.includes("\n")`，否则软换行输入会与历史竞争。
- 有选区时 `TextInput` 不绘制假光标；恢复假光标会与反色选区重叠，需同步修改 `tui.test.tsx` 的选区断言。

## 验收标准

- 可观察结果：
  - 输入 `hello 世界` 后 `Ctrl+A` 整段反色，`Ctrl+X` 清空并写入剪贴板；随后输入直接得到新内容。
  - 全选后输入字符、退格、`Ctrl+W` 都只删除选区。
  - 单行 `abc` 中按 `↑` 后输入 `!` 得到 `!abc`；按 `↓` 后输入 `?` 得到 `!abc?`。
  - 单行已在开头再按 `↑` 回退历史；已在末尾再按 `↓` 前进历史。
  - 多行/软换行输入仍按显示行移动光标。
  - secret 输入掩码不变，`Ctrl+A`/`Ctrl+X` 不产生选区或剪贴板写入。
- 自动化验证：
  - `apps/cli/test/inputSelection.test.ts`、`inputLayout.test.ts`、`tui.test.tsx`。
  - `pnpm --filter @answra/cli test`、`typecheck`、`biome check`。
- 需要的实机验证：
  - Windows Terminal / VS Code 集成终端下的 `Ctrl+A`、`Ctrl+X` 与中文/宽字符选区高亮。
  - 终端拦截 `Ctrl+X` 或 OSC 52 不可用时的兜底表现。

## 验证

- 2026-11-14：`pnpm --filter @answra/cli exec vitest run test/inputSelection.test.ts test/inputLayout.test.ts test/tui.test.tsx` 通过 3 个测试文件、50 个测试。
- 2026-11-14：`pnpm --filter @answra/cli typecheck` 通过；`pnpm biome check` 相关 9 个文件通过。
- 待完成：Windows Terminal / VS Code 集成终端实机走查；未完成前不能把本 Note 当作所有终端剪贴板路径已验收的依据。

## 风险

- 部分终端把 `Ctrl+A`/`Ctrl+X` 映射为自身快捷键或在 tmux/SSH 下转发异常；当前按 Ink 收到的键位处理，不做终端探测。
- OSC 52 写入依赖终端支持；本地 `Set-Clipboard` 兜底为异步 fire-and-forget，首次调用可能较慢，失败时没有用户提示。
- 选区仅支持全选，尚无 Shift+方向键或输入框鼠标拖选；用户可能预期更细粒度选择，后续需独立设计锚点扩展和指针坐标。
- 单行 `↑/↓` 优先段首/段尾会改变部分用户已有的历史浏览肌肉记忆；边界仍可浏览历史，但需要一次额外的按键。
- 窄列宽下长单行会被视为多视觉行，`↑/↓` 走显示行移动而不是段首/段尾；这是与渲染一致的取舍。
