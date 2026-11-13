# Note：CLI 输入光标导航与对话鼠标选区（对齐 Claude Code）

状态：提案

## 问题

CLI TUI 已能完成多轮 coding 对话，但输入框光标导航和对话区复制仍与 Claude Code 有明显差距：

- `PromptInput` 的 `↑/↓` 无条件走历史浏览（`apps/cli/src/tui/components/PromptInput.tsx:126`），多行输入中不会按显示行上下移动光标。
- `inputLayout` 只提供“文本偏移 → 光标行列”的单向布局（`apps/cli/src/tui/components/inputLayout.ts`），没有“目标行 + 显示列 → 文本偏移”的反向导航，因此软换行后的上下移动、行首/行尾都无法正确实现。
- `Home/End` 当前跳到整段首尾（`PromptInput.tsx:134`），软换行后语义不对；Claude Code 的 `Home/End` 是当前显示行边界，已在行首再按才退到上一行。
- 对话区为滚轮启用了鼠标 tracking（`apps/cli/src/tui/wheelInput.ts:4`、`runTui.tsx:120`），终端原生拖选被接管；应用内没有拖选、完整选区高亮、全选或复制，只能依赖终端 `Shift+拖选`，而且该限制已写进已实施 Note。
- 输入框粘贴没有归一化 `\r\n`；Windows/VS Code 终端的多行粘贴可能插入多余回车。
- 上一轮 TUI 重建明确把“完整鼠标选择/拖拽”列为后置项（见 [CLI TUI 对话交互重建](../../implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md) 的“曾考虑的替代方案”与“风险”），当前需求要求补齐该后置项。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/components/inputLayout.ts`：显示行模型、反向定位、行首/行尾纯函数。
  - `apps/cli/src/tui/components/PromptInput.tsx`、`TextInput.tsx`：接入换行感知光标导航与统一列宽。
  - `apps/cli/src/tui/wheelInput.ts`：扩展为指针输入（滚轮 + 按下/拖动/释放），并启用拖选所需鼠标 tracking。
  - `apps/cli/src/tui/selection.ts`（新增）：选区排序、ANSI 高亮、按显示列截取纯文本。
  - `apps/cli/src/tui/selectionStore.ts`（新增）：选区与已渲染行登记的唯一 writer，供 React 订阅与复制读取。
  - `apps/cli/src/tui/components/SelectableText.tsx`（新增）：把可选中文本行登记到 store，并按选区应用反色 transform。
  - `apps/cli/src/tui/clipboard.ts`（新增）：OSC 52 写入与本地剪贴板命令兜底。
  - `apps/cli/src/tui/components/App.tsx`、`runTui.tsx`、`commands.ts`：鼠标接线、复制快捷键、选区清理与帮助文案。
  - `apps/cli/test/inputLayout.test.ts`、`pointerInput.test.ts`、`selection.test.ts`、`tui.test.tsx`、`wheelInput.test.ts`（重命名/更新）。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；不改 Agent 事件、transcript 投影、IPC、持久化或 desktop。
  - 继续使用 `ink@8.0.0` + React 19.3，不引入 Claude Code 的 Ink fork。
  - 全屏模式启用 `1002` + `1006` 鼠标 tracking；`--no-alt-screen` 不启用，保留终端原生选择/复制。
- 相关 Note：
  - [CLI TUI 对话交互重建](../../implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md)
  - [CLI Coding 模式与终端 UI（TUI）移植](../architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [产品方向与 Agent 底座](../architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 参考仓库与移植边界

Claude Code 参考仓库（本地工作副本的 git remote）：

```text
https://github.com/pengchengneo/Claude-Code.git
```

拉取命令：

```bash
git clone https://github.com/pengchengneo/Claude-Code.git
```

该副本的 `package.json` 声明 upstream repository 为：

```text
https://github.com/anthropics/claude-code.git
```

但包内 `description` 明确写着 “Restored Claude Code source tree reconstructed from source maps”，许可证为 `SEE LICENSE IN LICENSE.md`。因此：

- 它是从 source map 还原的参考树，不是官方完整源码仓库；不要假设 upstream 仓库能提供同等源码。
- 只按行为、交互和布局复刻；不整段复制 `src/components`、`src/ink` 等源码，不复制 React Compiler 产物。
- 需要逐条对照的参考入口（只读、行为参考）：
  - `src/hooks/useTextInput.ts`：按键映射、上下按显示行/逻辑行移动、历史回退、Ctrl 键位。
  - `src/utils/Cursor.ts`：`MeasuredText`、软换行、`up()/down()`、`startOfLine()/endOfLine()`、grapheme 边界。
  - `src/ink/selection.ts`、`src/ink/ink.tsx`：选区模型、屏幕坐标、`copySelection` 与 OSC 52。
  - `src/ink/termio/osc.ts`：`setClipboard`、tmux/本地剪贴板兜底。
  - `src/keybindings/defaultBindings.ts`：`ctrl+shift+c` / `cmd+c` 复制绑定。
  - `src/components/PromptInput/*`：输入框布局、光标与粘贴。
- 我们的移植目标不是逐行重写，而是在 `apps/cli/src/tui` 内用 Ink 8 的公开能力补齐相同行为；不新增 `packages/tui`。

## 提案

### 1. 输入框：显示行反向导航

- 把 `inputLayout` 的显示行补成可逆模型：
  - `InputLine` 增加 `startOffset`、`endOffset`；`InputToken` 增加 `offset`。
  - 新增纯函数 `moveCursorVertically(value, cursor, columns, direction)`：按当前显示列移动到上/下一显示行；目标行不存在返回 `undefined`。
  - 新增 `startOfLineOffset` / `endOfLineOffset`：当前显示行边界；已在行首时 `Home` 退到上一行行首，对齐 Claude Code。
  - 宽字符/emoji 继续用 `Intl.Segmenter` + `string-width`，目标列落在宽字符中间时吸附到 grapheme 起点。
- `PromptInput`：
  - `↑/↓` 先尝试显示行移动；只有没有相邻显示行时才浏览历史。
  - `Home/End`、`Ctrl+A/Ctrl+E` 使用显示行边界；整段首尾不再借用这两个键。
  - 列宽只在 `PromptInput` 计算一次（终端列宽减去输入框装饰列），传给 `TextInput` 与导航函数，保证渲染和光标移动同源。
  - `usePaste` 插入前把 `\r\n?` 归一化为 `\n`。
  - `Ctrl+Shift+*` 不进入输入框的 Ctrl+C 退出/清空路径，避免与复制快捷键抢占。

### 2. 指针输入：滚轮 + 拖选

- 把 `wheelInput.ts` 扩展为 `pointerInput.ts`（或保留文件名但导出指针语义）：
  - 启用 `\x1b[?1002h\x1b[?1006h`（按键拖动跟踪 + SGR 坐标），不再只启用 `1000`。
  - 解析 SGR `\x1b[<b;x;yM|m`：
    - `b & 0x40` → 滚轮，保留现有上/下事件。
    - 左键无 motion 且 `M` → `press`。
    - 左键带 motion → `drag`。
    - `m` → `release`，携带最终坐标。
    - 中键/右键/其他修饰键忽略。
  - 保留 X10 滚轮兼容；X10 非滚轮事件不参与拖选。
  - 鼠标序列仍在 Ink 之前剥离，非鼠标字节原样转交 Ink；不把原始 SGR 序列交给 `useInput`。
- 事件消费：
  - `VirtualTranscript` 只消费 `wheel`。
  - `runTui` 消费 `press/drag/release`：按下时若该屏幕行已被登记为可选文本则开始选区，拖动时扩展，释放时结束并按需复制。
  - 滚轮/PgUp/PgDn 滚动时清除选区，避免屏幕坐标与内容错位。

### 3. 选区：屏幕坐标 + 已渲染行登记

- 选区以屏幕单元为坐标（0-based row/column，来自 SGR 坐标减 1），不按消息或字符偏移建模。
- 新增 `TuiSelectionStore` 作为唯一 writer：
  - `begin(point)`、`extend(point)`、`clearSelection()`、`selectAll()`、`getSnapshot()`、`subscribe()`。
  - 只保存一个 `{ anchor, focus }`；有序区间由纯函数 `orderSelection` 计算。
  - 记录当前帧已渲染行：`Map<row, { row, left, text }>`；文本为去 ANSI、去行尾空白的可见文本，`left` 是该行在屏幕上的起始列。
  - 行登记发生在渲染期，不触发 React 更新；选区变化才通知订阅者。
- 新增 `SelectableText`：
  - transcript 的行级 `<Text>` 替换为 `SelectableText`；内联嵌套 `<Text>` 保持原样。
  - 通过 Ink 的 `ink-text` host element 持有 ref 和 `internal_transform`，在不额外包一层 `Box` 的前提下取得绝对行列，避免破坏现有换行/宽度布局。
  - transform 每次渲染把该显示行的 `(row, left, text)` 写入 store，并在选区覆盖时插入 `\x1b[7m` / `\x1b[27m`。ANSI 颜色与选区反色可以叠加，遇到行内 reset 后重新开启反色。
  - 绝对位置按 Ink `renderNodeToOutput` 的同一规则累加 `getComputedTop/Left`，并减去祖先的 `contentOffsetX/Y`（虚拟 transcript 的滚动偏移）。
- 复制：
  - 按有序选区逐行读取已登记文本，用显示列截取首行/末行，中间行取整行；每行 `trimEnd`，去掉首尾空行后以 `\n` 连接。
  - 宽字符按显示列吸附到 grapheme 边界。
  - 选区只有 anchor 与 focus 不同时才视为可复制；单击不复制。

### 4. 剪贴板

- 主路径：向 stdout 写 OSC 52 `\x1b]52;c;<base64>\x07`（UTF-8）。
- 本地兜底（非 SSH）：`pbcopy`（macOS）、PowerShell `Set-Clipboard`（Windows）、`wl-copy`/`xclip`/`xsel`（Linux），fire-and-forget；OSC 52 可能已经成功，兜底失败不回显到 TUI。
- 不做剪贴板读取，不做图片复制；粘贴继续走 `usePaste` 进入输入框。
- tmux 透传与复杂剪贴板选择留到后续；本提案只保证本机终端。

### 5. 按键

- `Ctrl+Shift+C` / `Cmd+C`：复制当前选区。
- `Ctrl+Shift+A`：选中当前可见 transcript 全部已登记行并复制。
- `Esc`：有选区时先清除选区；其余语义（清空输入、取消运行）保持不变。
- 保留拖选释放自动复制，降低对终端组合键编码差异的依赖。
- 输入框内的 `Ctrl+C` 两次退出语义不变；`Ctrl+Shift+C` 不触发退出。

### 6. 不做

- 不 fork 或 vendor Claude Code 的 `src/ink`。
- 不做搜索高亮、hover、双击选词、点击定位输入光标、vim 模式、bidi、hyperlink。
- 不做跨屏/滚动后的持久选区；滚动即清空。
- 不做对话内容编辑，因此没有“剪切对话”语义；剪切只对输入框编辑有意义。
- 不改 Agent/transcript 投影、不新增持久化。

### 7. 分阶段实施顺序

1. 输入框导航：`inputLayout` 可逆模型 + `PromptInput/TextInput` + 单测。
2. 指针解析：`pointerInput` 事件模型 + 鼠标 tracking 启停 + 单测。
3. 选区核心：`selection.ts` 纯函数 + `TuiSelectionStore` + 单测。
4. 渲染接线：`SelectableText` 接入 `MarkdownText`、`MessageRow`、`ToolCard`、`Transcript` 的行级文本。
5. 复制链路：`clipboard.ts` + `runTui` press/drag/release + App 快捷键 + `tui.test.tsx`。
6. 文档与门禁：`/help`、Note、`pnpm --filter @answra/cli test`、typecheck、`pnpm verify`；最后做 VS Code / Windows Terminal 实机验收。

## 影响表面

- 用户可见：
  - 多行输入中 `↑/↓` 移动光标，到边界才浏览历史。
  - 软换行后 `Home/End` 按显示行工作。
  - 鼠标拖选对话文本、反色高亮、释放自动复制。
  - `Ctrl+Shift+C` / `Cmd+C` 复制选区，`Ctrl+Shift+A` 全选可见对话并复制，`Esc` 清除选区。
- 终端行为：
  - 全屏 TUI 接管鼠标按下/拖动/释放；不再依赖 `Shift+拖选`。
  - `--no-alt-screen` 不启用鼠标 tracking，保留终端原生滚动与复制。
- 性能：
  - 拖选期间每次鼠标移动通知 React；虚拟 transcript 只渲染可见窗口，选区只影响已渲染行。
  - 流式输出时若存在选区，内容变化会清空选区，避免旧坐标指向新文本。

## 模块边界

- 输入布局、选区纯函数、指针解析、剪贴板都在 `apps/cli/src/tui`，不下沉 `packages/ui`，不改 Agent。
- `TuiSelectionStore` 是选区与行登记的唯一 writer；`SelectableText` 只写行登记与渲染 transform，`runTui` 只发指针意图，App 只发选区命令。
- 不把 Claude Code 的 `MeasuredText`/`Screen` 原样搬进来；只保留行为等价的最小模型。
- 选区高亮依赖 Ink 的 `ink-text` host element 与 `internal_transform`。这是 Ink 内部但被官方 `Transform` 使用的路径，必须集中在一个文件并加注释；升级 Ink 后先跑选区集成测试。

## 曾考虑的替代方案

- **直接 vendor Claude Code 的 Ink fork：** 舍弃。约百个引擎文件，耦合 React Compiler、`AppState`、`bun:bundle`，维护和许可证成本都不可接受；本项目只复刻行为。
- **把整帧输出包装成屏幕缓冲再选区：** 舍弃。需要解析 Ink 增量渲染的 ANSI 光标移动与擦除，等价于自写终端模拟器；现有虚拟 transcript 已经知道可见行，按行登记成本更低。
- **给每行再包一层 `Box` 拿 ref：** 舍弃。额外 flex 层会改变行内文本的宽度分配和换行，尤其 ToolCard 标题行；改用 `ink-text` transform 保持布局。
- **关闭鼠标 tracking，完全依赖终端 `Shift+拖选`：** 只保留为 `--no-alt-screen` 行为。全屏模式下无法提供拖选高亮和释放自动复制，不能满足需求。
- **只做 `Ctrl+Shift+A` 全量复制，不做拖选：** 舍弃。用户明确要求对齐 Claude Code 的选区体验；全选复制只作为补充。
- **只用原生命令写剪贴板：** 舍弃。远程/SSH 会写错机器；OSC 52 是终端标准路径，原生命令只做本地兜底。
- **把选区建模为 transcript 字符偏移：** 舍弃。实际换行由 Ink/Yoga 完成，字符偏移与屏幕行列不一致；按屏幕坐标 + 已渲染行登记才是可验证来源。

## 验收标准

- 可观察结果：
  - 多行输入中，`↑/↓` 在显示行间移动并保持显示列；到首/末显示行才浏览历史。
  - 软换行与显式换行混合时，`Home/End` 落在当前显示行边界；宽字符/emoji 不错位。
  - 鼠标拖选 transcript 时出现反色高亮，释放后文本进入系统剪贴板；`Ctrl+Shift+C`/`Cmd+C` 可重复复制当前选区。
  - `Ctrl+Shift+A` 复制当前可见 transcript；`Esc` 清除选区。
  - 滚动或新消息导致内容变化后，旧选区不残留。
  - `--no-alt-screen` 下不接管鼠标，终端原生选择/滚动可用。
- 自动化验证：
  - `pnpm --filter @answra/cli test`：输入布局上下移动/行边界/宽字符；SGR 按下-拖动-释放解析与跨 chunk；选区排序、按列复制、ANSI 高亮；App 快捷键与选区清理。
  - `pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm architecture:check`、`pnpm notes:check`。
  - `pnpm verify` 全绿。
- 需要的实机验证：
  - VS Code 集成终端、Windows Terminal：鼠标拖选、释放复制、全选复制、长会话滚动、中文/emoji、终端 resize。
  - 确认 OSC 52 在目标终端可用；若首次使用有剪贴板权限提示，记录在 Note。
  - tmux/SSH 不列入本次验收。

## 当前实现进度（未验收）

- 已完成第一阶段原型：`inputLayout` 可逆显示行模型、`PromptInput`/`TextInput` 统一列宽与上下/Home/End 导航；`pnpm --filter @answra/cli test -- test/inputLayout.test.ts` 9/9 通过，CLI typecheck 通过。
- 尚未开始：指针解析、选区核心、`SelectableText` 渲染接线、剪贴板、App/runTui 快捷键、帮助文案与实机验收。
- 第一阶段原型尚未经过完整 `pnpm verify` 与实机验收，不得把本 Note 或该原型视为完整功能交付。

## 风险

- Ink 8 没有公开的“从渲染行取 ref”接口；本方案依赖 `ink-text` + `internal_transform`，属于内部但被 `Transform` 使用的路径。升级 Ink 后选区可能失效，必须用集成测试和实机验收兜底。
- 鼠标 tracking `1002` 会接管终端原生拖选；如果我们的选区实现有坐标偏差，用户会失去可用的复制路径。`--no-alt-screen` 是明确逃生口，实机验收未通过前不得宣称可用。
- OSC 52 在部分终端默认关闭或首次弹权限；本地原生命令兜底可能因 PATH/编码差异失败。复制失败目前静默，需要在实机验收中确认目标终端表现，必要时再补用户提示（不得静默改成“已复制”）。
- 虚拟 transcript 的 `contentOffsetY`、行高估算与 `measureElement` 回写会让绝对行坐标在滚动/流式输出时变化；选区在滚动和新消息时清空，流式文本变化仍可能造成一次高亮偏移。
- 选区每次拖动都触发 React 重渲染；长会话下如果可见行很多，可能出现掉帧。虚拟列表只渲染窗口内行，必要时再对选区通知做帧节流。
- 中文/宽字符在首/末列截取时可能包含半个显示单元格；按 grapheme 吸附可避免复制半个字符，但高亮边界可能与鼠标列差半格。
- 参考仓库是 source map 还原树，不是官方源码；任何“按参考实现粘贴”的做法都可能引入许可证与维护风险。只允许行为复刻，评审时按本条驳回整段复制。
