# Note：CLI 输入光标导航与对话鼠标选区（对齐 Claude Code）

状态：已实施

## 问题

CLI TUI 已能完成多轮 coding 对话，但输入框光标导航和对话区复制仍与 Claude Code 有明显差距：

- 实现前，输入框只有单向布局，软换行后的上下移动、Home/End 与历史浏览边界不一致。
- 纯交互原语与 React 组件混在一起：`inputLayout` 在 `components/`，指针解析、选区与剪贴板缺少独立层，继续堆会导致组件承担算法与终端 I/O。
- 对话区只为滚轮启用了鼠标 tracking（当时的 `wheelInput.ts`、`runTui.tsx`），终端原生拖选被接管；应用内没有拖选、完整选区高亮、全选或复制，只能依赖终端 `Shift+拖选`。
- 上一轮 TUI 重建明确把“完整鼠标选择/拖拽”列为后置项（见 [CLI TUI 对话交互重建](../architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md) 的“曾考虑的替代方案”与“风险”），本次补齐该后置项。

## 涉及范围

- 代码/模块（实际结构见“0. 架构与目录”）：
  - `apps/cli/src/tui/interaction/inputLayout.ts`：显示行模型、反向定位、行首/行尾纯函数（从 `components/` 移出）。
  - `apps/cli/src/tui/interaction/pointerInput.ts`（由 `wheelInput.ts` 重命名）：SGR/X10 指针解析、stdin 代理与鼠标 tracking 启停。
  - `apps/cli/src/tui/interaction/selection.ts`（新增）：选区排序、ANSI 高亮、按显示列截取纯文本。
  - `apps/cli/src/tui/interaction/selectionStore.ts`（新增）：选区与已渲染行登记的唯一 writer，供 React 订阅与复制读取。
  - `apps/cli/src/tui/interaction/clipboard.ts`（新增）：OSC 52 写入与本地剪贴板命令兜底。
  - `apps/cli/src/tui/components/SelectableText.tsx`（新增）：把可选中文本行登记到 store，并按选区应用反色 transform。
  - `apps/cli/src/tui/components/PromptInput.tsx`、`TextInput.tsx`：接入换行感知光标导航与统一列宽。
  - `apps/cli/src/tui/components/App.tsx`、`VirtualTranscript.tsx`、`MarkdownText.tsx`、`ToolCard.tsx`、`runTui.tsx`、`commands.ts`：快捷键意图、滚动清选区、行级文本接入、组合根接线与帮助文案。
  - `apps/cli/test/inputLayout.test.ts`、`pointerInput.test.ts`（由 `wheelInput.test.ts` 重命名）、`selection.test.ts`、`selectionStore.test.ts`、`selectionActions.test.ts`、`clipboard.test.ts`、`selectableText.test.tsx`、`tui.test.tsx`、`runTui.test.ts`。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；不改 Agent 事件、transcript 投影、IPC、持久化或 desktop。
  - 继续使用 `ink@8.0.0` + React 19.3，不引入 Claude Code 的 Ink fork。
  - 全屏模式启用 `1002` + `1006` 鼠标 tracking；`--no-alt-screen` 不创建指针与选区 store，保留终端原生选择/复制。
  - 不新增 `packages/tui`；只有出现第二个终端宿主或原语被复用时再抽包。
- 相关 Note：
  - [CLI TUI 对话交互重建](../architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md)
  - [CLI Coding 模式与终端 UI（TUI）移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 参考仓库与移植边界

Claude Code 参考仓库（本地工作副本的 git remote）：

```text
https://github.com/pengchengneo/Claude-Code.git
```

拉取命令：

```bash
git clone https://github.com/pengchengneo/Claude-Code.git
```

本仓库当前把该参考树放在根目录 `Claude-Code/`，已加入 `.gitignore`，只作只读行为参考；不得把参考树整体提交，也不得让 CLI 构建依赖它。

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

## 决定

### 0. 架构与目录

选区、指针和剪贴板属于终端交互原语，不属于 Ink 组件。目标是在 `apps/cli/src/tui` 内按职责分层，而不是继续把纯函数堆进 `components/`：

```text
apps/cli/src/tui/
├─ runTui.tsx                 # 唯一组合根：指针、选区、剪贴板、Ink onRender 接线
├─ viewStore.ts               # ConversationView 投影与 run 阶段
├─ commands.ts                # 本地 slash 命令与帮助文案
├─ theme.ts
├─ interaction/               # 终端交互原语；除 pointerInput 用 node:stream 外不依赖 Ink/React
│  ├─ inputLayout.ts          # 输入框显示行布局纯函数（从 components/ 移出）
│  ├─ pointerInput.ts         # SGR/X10 指针解析 + stdin 代理
│  ├─ selection.ts            # 屏幕坐标选区纯函数
│  ├─ selectionStore.ts       # 选区与已渲染行的唯一 writer
│  └─ clipboard.ts            # 复制输出端口实现
└─ components/
   ├─ SelectableText.tsx      # 唯一 React 选区渲染原语：登记行 + 反色 transform
   ├─ App.tsx                 # 布局与快捷键意图，不解析指针、不写剪贴板
   ├─ VirtualTranscript.tsx   # 滚动/虚拟窗口，只消费 wheel 与 onScroll
   ├─ PromptInput.tsx / TextInput.tsx
   ├─ MarkdownText.tsx / MessageRow.tsx / MessageResponse.tsx / ToolCard.tsx
   ├─ Transcript.tsx / StatusLine.tsx / Spinner.tsx
   └─ virtualLayout.ts        # 纯布局，与 VirtualTranscript co-location
```

依赖方向固定为：

```text
theme
  ↑
components ──→ interaction
  ↑
runTui ─────→ pointerInput / selectionStore / clipboard / App
```

- `interaction/*` 不 import `components/*` 或 `runTui`；`pointerInput` 只依赖 `node:stream` 与选区坐标类型。
- `components/*` 不解析 SGR、不调用剪贴板、不计算复制文本；只通过纯函数或 store 端口表达意图。
- `runTui` 是唯一组合根：创建指针输入、选区 store、剪贴板 writer 与 `selectionActions`，挂 `onRender` 提交帧，把快捷键意图接到复制。
- 选区只在 `alternateScreen` 下启用：`--no-alt-screen` 不创建指针与 store，`SelectableText` 回退为普通 `<Text>`，不接管终端原生复制。

先冻结接口，再并行实现：

```ts
type PointerEvent =
  | { kind: "wheel"; direction: -1 | 1; point: SelectionPoint }
  | { kind: "press"; point: SelectionPoint }
  | { kind: "drag"; point: SelectionPoint }
  | { kind: "release"; point: SelectionPoint };

interface PointerSource {
  subscribe(listener: (event: PointerEvent) => void): () => void;
}

interface ClipboardWriter {
  write(text: string): void;
}

class TuiSelectionStore {
  registerLine(line: RenderedLine): void;
  commitFrame(): void;
  hasLine(row: number): boolean;
  begin(point: SelectionPoint): void;
  extend(point: SelectionPoint): void;
  clear(): void;
  selectAll(): void;
  getBounds(): SelectionBounds | undefined;
  getSelectedText(): string;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
}
```

状态与数据流只有一个方向：

```text
终端字节 → pointerInput 解析
  ├─ wheel → VirtualTranscript 滚动 + onScroll 清选区
  └─ press/drag/release → runTui → TuiSelectionStore

SelectableText 渲染期 → store.registerLine（只登记，不通知）
Ink onRender → store.commitFrame（唯一帧提交点）
选区变化 → store.notify → App / SelectableText 重渲染

复制：release / Ctrl+Shift+C / Ctrl+Shift+A
  → selectionActions 读取 store.getSelectedText()
  → ClipboardWriter.write()
```

硬约束：选区状态只由 `TuiSelectionStore` 写；已渲染行只由 `SelectableText` 写；帧提交只在 `runTui` 的 `onRender`；`App` 只发复制/全选/清除意图；`VirtualTranscript` 只消费 `wheel`。

### 1. 输入框：显示行反向导航

- 把 `inputLayout` 的显示行补成可逆模型：
  - `InputLine` 增加 `startOffset`、`endOffset`；`InputToken` 增加 `offset`。
  - 新增纯函数 `moveCursorVertically(value, cursor, columns, direction)`：按当前显示列移动到上/下一显示行；目标行不存在返回 `undefined`。
  - 新增 `startOfLineOffset` / `endOfLineOffset`：当前显示行边界；已在行首时 `Home` 退到上一行行首，对齐 Claude Code。
  - 宽字符/emoji 继续用 `Intl.Segmenter` + `string-width`，目标列落在宽字符中间时吸附到 grapheme 起点。
- `PromptInput`：
  - `↑/↓` 先尝试显示行移动；单行输入时先到整段开头/末尾，已在边界才浏览历史；多行输入没有相邻显示行时直接浏览历史（2026-11-14 起）。
  - `Home/End`、`Ctrl+E` 使用显示行边界；`Ctrl+A` 在 2026-11-14 改为全选输入内容，不再借用为行首。
  - 列宽只在 `PromptInput` 计算一次（终端列宽减去输入框装饰列），传给 `TextInput` 与导航函数，保证渲染和光标移动同源。
  - `usePaste` 插入前把 `\r\n?` 归一化为 `\n`。
  - `Ctrl+Shift+*` 不进入输入框的 Ctrl+C 退出/清空路径，避免与复制快捷键抢占。

### 2. 指针输入：滚轮 + 拖选

- 把 `wheelInput.ts` 重命名为 `interaction/pointerInput.ts`，导出统一的 `PointerEvent`：
  - 启用 `\x1b[?1002h\x1b[?1006h`（按键拖动跟踪 + SGR 坐标），不再只启用 `1000`。
  - 解析 SGR `\x1b[<b;x;yM|m`：
    - `b & 0x40` → `wheel`；只有纵向滚轮产生方向，水平滚轮忽略。
    - 左键无 motion 且 `M` → `press`。
    - 左键带 motion → `drag`。
    - `m` → `release`，携带最终坐标。
    - 中键/右键/带修饰键的左键忽略；Shift+拖选留给终端原生转义。
  - 保留 X10 滚轮兼容；X10 非滚轮事件不参与拖选。
  - 鼠标序列仍在 Ink 之前剥离，非鼠标字节原样转交 Ink；不把原始 SGR 序列交给 `useInput`。
  - SGR 的 1-based 坐标在解析边界统一转成 0-based `SelectionPoint`，下游不再换算。
- 事件消费：
  - `VirtualTranscript` 只消费 `wheel`，忽略 press/drag/release。
  - `selectionActions` 消费 `press/drag/release`：按下时若该屏幕行已被登记为可选文本则 `begin`，否则清除旧选区；拖动时 `extend`；释放时自动复制非空选区。
  - 滚轮/PgUp/PgDn 滚动时通过 `onScroll` 清除选区，避免屏幕坐标与内容错位。

### 3. 选区：屏幕坐标 + 已渲染行登记

- 选区以屏幕单元为坐标（0-based row/column），不按消息或字符偏移建模。
- 新增 `TuiSelectionStore` 作为唯一 writer：
  - `begin(point)`、`extend(point)`、`clear()`、`selectAll()`、`hasSelection()`、`getBounds()`、`getSelectedText()`、`hasLine(row)`。
  - `getVersion()` + `subscribe()` 供 React `useSyncExternalStore` 订阅；只在选区真正变化时递增版本。
  - 只保存一个 `{ anchor, focus }`；有序区间由纯函数 `orderSelection` 计算，anchor 与 focus 相同视为无选区，单击不复制。
  - 渲染期用 `registerLine({ row, left, text })` 写入 pending；`commitFrame()` 把 pending 切换为可复制快照。帧提交只能由 `runTui` 的 Ink `onRender` 调用，组件不得自行提交。
  - 已渲染行文本为去 ANSI 的可见文本，`left` 是该行在屏幕上的起始列；同一 row 只保留最后一次登记。
  - 选区悬停/拖动导致的重渲染只更新 transform，不写 transcript 或 Agent 事件。
- 新增 `components/SelectableText.tsx`：
  - transcript 的行级 `<Text>` 替换为 `SelectableText`；内联嵌套 `<Text>` 保持原样。
  - 通过 Ink 的 `ink-text` host element 持有 ref 和 `internal_transform`，在不额外包一层 `Box` 的前提下取得绝对行列，避免破坏现有换行/宽度布局。
  - 样式仍交给内部 `<Text>`，外层 host 只负责 `internal_transform` 与行登记；禁止在 `SelectableText` 内计算复制文本或写剪贴板。
  - 通过 `SelectionContext` 读取唯一 store；没有 store（非全屏或组件测试）时直接渲染普通 `<Text>`，不登记行。
  - transform 每次渲染把该显示行的 `(row, left, text)` 写入 store，并在选区覆盖时插入 `\x1b[7m` / `\x1b[27m`。ANSI 颜色与选区反色可以叠加，遇到行内 full reset 后重新开启反色。
  - 绝对位置按 Ink `renderNodeToOutput` 的同一规则累加 `getComputedTop/Left`，并减去祖先的 `contentOffsetX/Y`（虚拟 transcript 的滚动偏移）。
  - 该文件是唯一依赖 Ink 内部 `ink-text` / `internal_transform` 的地方；升级 Ink 时先跑选区与滚动集成测试。
- 复制：
  - 按有序选区逐行读取已登记文本，用显示列截取首行/末行，中间行取整行；每行 `trimEnd`，去掉首尾空行后以 `\n` 连接。
  - 宽字符按显示列吸附到 grapheme 边界。
  - 选区只有 anchor 与 focus 不同时才视为可复制；单击不复制。

### 4. 剪贴板

- 新增 `interaction/clipboard.ts`，只暴露 `ClipboardWriter.write(text)` 端口；只有 `runTui` 能调用它，组件与 store 不直接写 stdout。
- 主路径：向 stdout 写 OSC 52 `\x1b]52;c;<base64>\x07`（UTF-8）。
- 本地兜底（非 SSH）：`pbcopy`（macOS）、PowerShell `Set-Clipboard`（Windows，经 stdin 传文本避免命令行长度与编码问题）、`wl-copy`/`xclip`/`xsel`（Linux），fire-and-forget；OSC 52 可能已经成功，兜底失败不回显到 TUI。
- `spawn` 失败被显式忽略并注明原因（兜底路径，不能把失败误报成复制失败）；除该边界外禁止 catch-all。
- 不做剪贴板读取，不做图片复制；粘贴继续走 `usePaste` 进入输入框。
- tmux 透传与复杂剪贴板选择留到后续；本实现只保证本机终端。

### 5. 按键

- 只在 `alternateScreen` 下启用；`--no-alt-screen` 不拦截任何复制快捷键，保留终端原生选择/复制。
- `App` 只发意图：`onCopySelection()`、`onSelectAll()`、`onClearSelection()`；实际复制由 `runTui` 组合 store 与 clipboard 完成。
- `Ctrl+Shift+C` / `Cmd+C`：复制当前选区。
- `Ctrl+Shift+A`：选中当前可见 transcript 全部已登记行并复制。
- `Esc`：有选区时先清除选区；其余语义（清空输入、取消运行）保持不变。
- 保留拖选释放自动复制，降低对终端组合键编码差异的依赖。
- 输入框内的 `Ctrl+C` 两次退出语义不变；`Ctrl+Shift+C` 不触发退出，也不进入输入框编辑路径。
- 帮助文案必须与实现同步：说明拖选、`Ctrl+Shift+C`/`Cmd+C`、`Ctrl+Shift+A`、`Esc` 清选区，以及 `--no-alt-screen` 下使用终端原生复制。

### 6. 并行实施切分

先合并契约（`PointerEvent`、`PointerSource`、`ClipboardWriter`、`TuiSelectionStore`），再开并行流。契约变更必须先改契约并通知所有流。

| 工作流 | 文件 | 依赖 | 并行约束 |
| --- | --- | --- | --- |
| A 指针输入 | `interaction/pointerInput.ts`、`test/pointerInput.test.ts` | 仅契约 | 不碰 `components/` |
| B 选区核心 | `interaction/selection.ts`、`interaction/selectionStore.ts`、对应测试 | 仅契约 | 不碰 Ink/React |
| C 渲染接线 | `components/SelectableText.tsx`、`MarkdownText.tsx`、`ToolCard.tsx`、`test/selectableText.test.tsx` | B 的契约，可用 fake store | 不碰 `runTui`/`App` |
| D 组合与快捷键 | `runTui.tsx`、`App.tsx`、`VirtualTranscript.tsx`、`commands.ts`、`test/tui.test.tsx`、`test/runTui.test.ts` | A/B/C 契约，先用 fake source | 独占组合文件 |
| E 文档与门禁 | 本 Note、`pnpm verify`、实机验收 | 全部 | 最后执行 |

冲突控制：`runTui.tsx` / `App.tsx` / `VirtualTranscript.tsx` 只由 D 修改；A/B 各自只改 `interaction/`；C 的测试放新文件，不和 D 抢 `tui.test.tsx`。

### 7. 不做

- 不 fork 或 vendor Claude Code 的 `src/ink`。
- 不做搜索高亮、hover、双击选词、点击定位输入光标、vim 模式、bidi、hyperlink。
- 不做跨屏/滚动后的持久选区；滚动即清空。
- 不做对话内容编辑，因此没有“剪切对话”语义；剪切只对输入框编辑有意义。
- 不改 Agent/transcript 投影、不新增持久化。

### 8. 实际落地

1. 清理中间态：`wheelInput.ts` 改名并移动到 `interaction/pointerInput.ts`，`components/inputLayout.ts` 移到 `interaction/`，同步全部 import。
2. 契约落地：`PointerEvent`/`PointerSource`/`ClipboardWriter`/`TuiSelectionStore` 定稿；新增 `selectionActions.ts` 统一指针到选区/复制的编排。
3. 指针输入：SGR/X10 解析、按下-拖动-释放、修饰键忽略、鼠标 tracking 启停与跨 chunk 测试。
4. 选区核心：`selection.ts` 纯函数 + `TuiSelectionStore` 帧快照与复制文本测试。
5. 渲染接线：`SelectableText` 接入 `MarkdownText` 与 `ToolCard` 的行级文本，`MessageRow` 经 `MarkdownText` 间接覆盖；无 store 时回退普通 `<Text>`。
6. 组合与快捷键：`runTui` 的指针接线、`onRender` 帧提交、`App` 快捷键意图、`VirtualTranscript` 的滚动/内容变化清选区、`/help` 文案；补 `tui.test.tsx` / `runTui.test.ts`。
7. 文档与门禁：更新本 Note、`pnpm --filter @answra/cli test`、`typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm verify`。

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

- 输入布局、选区纯函数、指针解析、剪贴板都在 `apps/cli/src/tui/interaction`，不下沉 `packages/ui`，不改 Agent，不新增 `packages/tui`。
- 依赖方向固定：`components → interaction`、`runTui → interaction + components`；`interaction` 不得 import `components`，组件不得解析 SGR 或写剪贴板。
- `TuiSelectionStore` 是选区与行登记的唯一 writer；`SelectableText` 只 `registerLine` 与应用 transform；`selectionActions` 是复制编排点；`runTui` 是唯一帧提交与组合接线点；`App` 只发复制/全选/清除意图。
- 非全屏模式不创建指针与选区 store；`SelectableText` 在无 store 时回退为普通 `<Text>`，不承担交互。
- 不把 Claude Code 的 `MeasuredText`/`Screen` 原样搬进来；只保留行为等价的最小模型。
- 选区高亮依赖 Ink 的 `ink-text` host element 与 `internal_transform`。这是 Ink 内部但被官方 `Transform` 使用的路径，必须集中在 `SelectableText.tsx` 并加注释；升级 Ink 后先跑选区集成测试。

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
  - `pnpm --filter @answra/cli test`：输入布局上下移动/行边界/宽字符；SGR 按下-拖动-释放与修饰键忽略、跨 chunk、鼠标 tracking 启停；选区排序、按列复制、宽字符吸附、ANSI 高亮；store 帧提交与单一 writer；App 快捷键意图、`onScroll` 清选区、`--no-alt-screen` 回退。
  - `pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm architecture:check`、`pnpm notes:check`。
  - `pnpm verify` 全绿。
- 需要的实机验证：
  - VS Code 集成终端、Windows Terminal：鼠标拖选、释放复制、全选复制、长会话滚动、中文/emoji、终端 resize。
  - 确认 OSC 52 在目标终端可用；若首次使用有剪贴板权限提示，记录在 Note。
  - tmux/SSH 不列入本次验收。

## 验证

- 目录与模块：
  - `interaction/inputLayout.ts`、`pointerInput.ts`、`selection.ts`、`selectionStore.ts`、`selectionActions.ts`、`clipboard.ts` 已落地。
  - `components/SelectableText.tsx` 已接入 `MarkdownText` 与 `ToolCard`；`runTui` 负责创建 store/pointer/clipboard/selectionActions 并挂 `onRender` 帧提交。
  - `App` 只发复制/全选/清除意图；`VirtualTranscript` 只消费 wheel，并在 PgUp/PgDn、滚轮、消息变化时清选区。
- 自动化证据：
  - `pnpm --filter @answra/cli test`：20 个测试文件、120 个测试全部通过。
  - `pnpm --filter @answra/cli typecheck` 通过。
  - `pnpm lint`、`pnpm verify` 通过；架构检查与设计令牌检查通过。
  - `pnpm notes:check` 通过。
- 尚未完成：
  - VS Code 集成终端、Windows Terminal 的实机拖选/复制/中文/emoji/长会话验收。
  - Windows PowerShell `Set-Clipboard` 兜底的实机表现与首次调用耗时。
  - 在实机验收通过前，不把 OSC 52 或本地兜底宣称为所有终端可用。

## 后果与防回退

- 选区与已渲染行只能由 `TuiSelectionStore` 写；新增选区能力必须扩展该 store，不能在组件或组合根另建第二份选区状态。
- 行登记只能来自 `SelectableText`；文本组件不得绕过它直接解析屏幕坐标或自行调用剪贴板。
- 帧提交只能由 `runTui` 的 Ink `onRender` 调用；复制读取已提交快照，不能直接读渲染期 pending。
- `App` 只发复制/全选/清除意图，`VirtualTranscript` 只消费 wheel；不得把 SGR 解析或剪贴板 I/O 下放到组件。
- `--no-alt-screen` 永久保留终端原生选择/复制；新增鼠标能力必须同时维护该逃生口。
- 不 fork/vendor Claude Code Ink；Ink 内部 `ink-text`/`internal_transform` 依赖只集中在 `SelectableText.tsx`，升级 Ink 先跑选区集成测试。
- 目录边界：`interaction` 不得 import `components`/`runTui`，也不得新增 `packages/tui` 直到第二个终端宿主出现。

## 风险

- Ink 8 没有公开的“从渲染行取 ref”接口；本方案依赖 `ink-text` + `internal_transform`，属于内部但被 `Transform` 使用的路径。升级 Ink 后选区可能失效，必须用集成测试和实机验收兜底。
- 鼠标 tracking `1002` 会接管终端原生拖选；如果我们的选区实现有坐标偏差，用户会失去可用的复制路径。`--no-alt-screen` 是明确逃生口，实机验收未通过前不得宣称可用。
- OSC 52 在部分终端默认关闭或首次弹权限；本地原生命令兜底可能因 PATH/编码差异失败。复制失败目前静默，需要在实机验收中确认目标终端表现，必要时再补用户提示（不得静默改成“已复制”）。
- 虚拟 transcript 的 `contentOffsetY`、行高估算与 `measureElement` 回写会让绝对行坐标在滚动/流式输出时变化；选区在滚动和新消息时清空，流式文本变化仍可能造成一次高亮偏移。
- 选区每次拖动都触发 React 重渲染；长会话下如果可见行很多，可能出现掉帧。虚拟列表只渲染窗口内行，必要时再对选区通知做帧节流。
- 中文/宽字符在首/末列截取时可能包含半个显示单元格；按 grapheme 吸附可避免复制半个字符，但高亮边界可能与鼠标列差半格。
- 行登记发生在 `internal_transform`，帧提交依赖 `runTui` 的 Ink `onRender`；如果后续改成并发渲染或替换 Ink 版本，必须验证“复制读取的是上一帧已提交快照”，不能直接读 pending。
- `SelectableText` 的首个 transform 早于 React 挂载 ref，当前用一次 `mounted` 状态重渲染确保行被登记；若 React/Ink 的 ref 时序变化，`selectableText.test.tsx` 的 `hasLine` 断言会先失败。
- 目录迁移（`components/inputLayout.ts` → `interaction/`）会同时改 `PromptInput`、`TextInput` 与测试 import；迁移必须与功能改动分开提交，避免把机械重命名混进行为 diff。
- Windows 剪贴板兜底通过 PowerShell stdin 写入，首次调用可能较慢；该路径是 fire-and-forget，不得在 UI 上提前宣称“已复制”，实机验收记录实际表现。
- 参考仓库是 source map 还原树，不是官方源码；任何“按参考实现粘贴”的做法都可能引入许可证与维护风险。只允许行为复刻，评审时按本条驳回整段复制。
