# Note：CLI TUI 对话交互重建（虚拟滚动、输入与按键归属）

状态：已实施

## 问题

CLI TUI 已经能启动并完成单轮对话，但在 VS Code 集成终端中的核心交互仍不可用：

- `Transcript` 每次 store 更新都渲染全部历史消息，`MarkdownText` 每次重新解析全部文本；流式输出时 CPU 和画面抖动随会话长度线性增长。
- 现有 `ScrollBox` 只通过 `contentOffsetY` 平移完整布局，长 transcript 仍全部参与 Yoga 布局；没有可视区裁剪，也没有可靠的测量与跟随。
- `PromptInput` 用 UTF-16 下标和单个 `<Text inverse>` 画光标，中文、emoji、宽字符会错位；长输入没有高度上限。
- `ScrollBox` 与 `PromptInput` 都处理 Home/End，输入时切光标会同时跳 transcript。
- 思考块对每个 reasoning part 都显示标签，Ctrl+O 只展开文本，不能复刻 transcript 模式的整体展开语义。
- `StatusLine` 用 `space-between` 放长模型名和工作区路径，窄终端会换行或挤压输入区。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/components/VirtualTranscript.tsx`（新增）：视口测量、虚拟列表、跟随/滚动。
  - `apps/cli/src/tui/components/TextInput.tsx`（新增）：宽字符/换行/视口感知的输入投影。
  - `apps/cli/src/tui/components/inputLayout.ts`（新增）：纯文本布局与光标定位，供测试直接覆盖。
  - `apps/cli/src/tui/wheelInput.ts`（新增）：终端 SGR/X10 滚轮事件解析，并把非滚轮输入原样转交 Ink。
  - `apps/cli/src/tui/components/App.tsx`、`Transcript.tsx`、`MessageRow.tsx`、`MarkdownText.tsx`、`ToolCard.tsx`、`StatusLine.tsx`、`PromptInput.tsx`：接入上述原语。
  - `apps/cli/test/tui.test.tsx`、`apps/cli/test/inputLayout.test.ts`、`apps/cli/test/wheelInput.test.ts`（新增）：行为与布局测试。
- UI/进程/协议/持久化表面：
  - 仍使用 `ink@8.0.0` + React 19.3，不引入 Claude Code 的 Ink fork。
  - 仍使用 `alternateScreen`、`useWindowSize`、`useBoxMetrics`、`measureElement`、`usePaste`。
  - 不新增持久化、协议或 Agent 语义。
- 相关 Note：
  - [CLI Coding 模式与终端 UI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [CLI 输入光标导航与对话鼠标选区（提案）](../../proposed/feature/2026-11-13-cli-input-navigation-and-transcript-selection.md)
  - [CLI dev 脚本](../process/2026-11-13-cli-dev-script.md)

## 决定

### 1. 虚拟 transcript

- 新增 `VirtualTranscript`，由它持有 transcript 视口：
  - 用 `useBoxMetrics(viewportRef)` 获取可视高度。
  - 用 `measureElement` 对已渲染消息逐项测量高度，缓存 `messageId -> height`。
  - 未测量消息使用基于列宽和文本行数的估算高度，估算只影响滚动位置，不改变最终渲染内容。
  - 只渲染与 `[scrollTop, scrollTop + viewportHeight]` 相交的消息，附加一屏 overscan；上方未渲染内容不再进入 Yoga 布局。
  - 跟随状态与偏移合并为单一 `{ top, following }` state；在底部时直接派生 `scrollTop = maxScrollTop`，用户 PgUp/滚轮上移后退出跟随，回到底部时恢复。
  - 旧实现用 `useRef` 保存 `following`，而 `scrollTop` 在底部保持 0。一次 stdin chunk 内的连续滚轮事件最终回到 0 时，React 会认为 state 未变化而跳过重绘，表现为运行中滚不动；现在 `following` 变化本身会触发提交。
  - 视口宽度或 `expandThinking` 变化时清空高度缓存并重新测量。
- `MessageRow`、`MarkdownText`、`ToolCard` 使用 `memo`；`MarkdownText` 用 `useMemo` 缓存解析结果。
- 保留 `Transcript` 作为非虚拟内容投影，供测试和未来小面板使用；生产 TUI 走 `VirtualTranscript`。

### 2. 输入框

- 新增纯函数 `layoutInput`：
  - 用 `Intl.Segmenter` 按 grapheme 切分，`string-width` 计算显示宽度。
  - 按终端列宽换行，保留显式换行和空行。
  - 返回可视行、光标所在行/列、是否需要上方/下方溢出提示。
- `TextInput` 只负责把 `layoutInput` 的结果渲染成 `<Text>`，光标用反色 grapheme 或反色空格。
- `PromptInput`：
  - 左右移动、Backspace、Delete 按 grapheme 处理。
  - 上下方向键在显示行之间移动并保持显示列；已在首/末显示行时回落为历史浏览。
  - Home/End 按视觉行边界移动；光标已在行首时 Home 退到上一显示行行首，不再依赖逻辑换行。
  - Shift+方向键不消费，避免与终端选择/未来扩展冲突。
  - 输入区最多显示 `maxVisibleLines` 行，随 `useWindowSize().rows` 计算，长输入不再顶掉 transcript。
  - 通过 `usePaste` 接收 bracketed paste，多行粘贴只插入一次状态；CRLF/CR 统一为 LF。
  - Enter 提交，Shift+Enter 换行，反斜杠续行继续保留；运行中 Enter 排队语义不变。
- `runTui` 打开 Ink 的 `kittyKeyboard` auto/disambiguate，终端支持时提高 Shift+Enter 等组合键的区分度；不支持时仍保留反斜杠续行。

### 3. 按键归属

- Home/End 只归 `PromptInput`，用于输入光标；`VirtualTranscript` 不再处理 Home/End。
- `VirtualTranscript` 只处理 PgUp/PgDn，这两键不被输入框消费。
- App 继续只处理 Ctrl+O、运行中 Esc、运行中 Ctrl+C；PromptInput 处理空闲 Ctrl+C、Esc 清空和编辑键。
- 全屏 TUI 启用最小鼠标 tracking（`1000` + `1006`）：`runTui` 在 Ink 前插入一个 stdin 代理，`wheelInput` 解析 SGR/X10 滚轮事件并只把非鼠标字节转交 Ink；鼠标 tracking 关闭时回退到终端原生滚动。
- 滚轮每次移动 3 行，PgUp/PgDn 仍按半屏移动；任意上滚立即退出底部跟随，滚回底部恢复跟随。
- 鼠标 tracking 会接管终端拖选；需要复制时使用终端自身的“按住 Shift 拖选”转义。该限制写进 Note，不伪装成原生选择。

### 4. 展开与布局

- Ctrl+O 统一为 transcript 展开开关：展开当前所有思考块和工具完整输出；折叠时只保留最近一条 assistant 的思考标签，历史思考隐藏。
- 工具卡在展开态显示完整输出/更大 diff 窗口，折叠态维持现有摘要。
- `StatusLine` 按终端列宽分配左右区域，长 Bot/模型名和工作区路径用截断显示，阶段标签固定宽度。

## 模块边界

- 虚拟化、输入布局、终端渲染都留在 `apps/cli/src/tui`，不下沉 `packages/ui`，也不改 Agent 事件投影。
- `VirtualTranscript` 只消费 `ConversationView` 和既有 `MessageRow`，不重写消息语义。
- `layoutInput` 是纯函数，不依赖 Ink/React，测试不需要渲染终端。

## 曾考虑的替代方案

- **继续用 `contentOffsetY` 平移全部消息：** 舍弃。它解决了“底部看不见”，但不能减少布局和渲染成本，长会话仍会卡；虚拟列表才是根因修复。
- **直接移植 Claude Code 的 `VirtualMessageList` / 自定义 Ink fork：** 舍弃。依赖 React Compiler、`AppState`、`bun:bundle` 和约百个引擎文件，维护与版权成本不可接受；本方案复刻行为与测量方式，不复制实现。
- **固定行高虚拟列表：** 舍弃。消息高度差异大，固定行高会导致滚动跳跃和定位错误；采用测量缓存 + 估算兜底。
- **只在流式时截断历史：** 舍弃。用户向上滚动时仍需要完整历史，而且截断会破坏滚动位置和 transcript 语义。
- **用字符串长度估算光标列宽：** 舍弃。中文、emoji、组合字符会错位；采用 grapheme + `string-width`。
- **继续等待上游 Ink 提供滚轮事件：** 舍弃。Ink 8 会把完整 SGR 鼠标序列当作未知控制序列丢弃，无法从 `useInput` 获得滚轮；在 Ink 前增加最小 stdin 代理是当前可维护的做法。
- **启用完整鼠标选择/拖拽：** 本次舍弃。只启用滚轮所需的 `1000` + `1006`，不接管 hover 与拖拽选择，避免扩大与 Ink 输入、终端复制的冲突面。

## 验收标准

- 可观察结果：
  - 40 条以上消息时，初始视口只渲染底部可见窗口，按 PgUp 能看到上方消息，PgDn 回到底部并恢复跟随。
  - 输入中文、emoji、长文本时，光标跟随正确，输入区不超过最大可视行数。
  - 多行输入按上下键在显示行之间移动，Home/End 作用于当前视觉行；在输入框按 Home/End 不改变 transcript 滚动位置。
  - Ctrl+O 展开/收起当前思考与工具完整输出，历史思考在折叠态不重复堆叠。
  - 窄终端下状态行不换行、不挤压输入框。
- 自动化验证：
  - `pnpm --filter @answra/cli test`：新增输入布局、虚拟窗口、按键归属、展开语义、滚轮序列解析与运行中滚动测试。
  - `pnpm --filter @answra/cli typecheck`。
- 需要的实机验证：
  - VS Code 集成终端：长会话滚动、PgUp/PgDn、滚轮、Shift+Enter、Ctrl+O、中文/emoji 输入、窗口 resize。
  - 滚轮必须实机确认；未验证前不得把本 Note 当作滚轮已验收的依据。

## 后果与防回退

- 生产 TUI 不再使用 `ScrollBox`；`Transcript` 只保留为非虚拟内容投影。新增滚动能力必须回到 `VirtualTranscript`，不能重新引入“全量消息 + `contentOffsetY` 平移”的旧实现。
- Home/End 永久归输入框；如果未来需要 transcript 顶部/底部快捷键，必须使用新的组合键并同步帮助文案，不能抢回 Home/End。
- `layoutInput` 是光标列宽的唯一来源；禁止在 `PromptInput`/`TextInput` 里重新用 `value.length` 或 `slice(cursor + 1)` 计算光标。
- 思考折叠只保留当前 turn 的最后一条 assistant 思考；Ctrl+O 是 transcript 展开开关，不再新增第二套“只展开思考”的状态。
- 鼠标滚轮只在 `alternateScreen` 模式启用；`--no-alt-screen` 保留终端原生 scrollback 与原生滚轮，不得把两套滚动行为混在一起。
- `wheelInput` 是 stdin 的唯一前置过滤器；新增鼠标能力（点击、拖选、hover）必须扩展这里，不能让原始 SGR 序列绕过过滤器进入 Ink 或输入框。
- 虚拟列表的高度缓存以 `measureKey` 失效；新增会影响消息高度的 prop 时必须同时进入 `measureKey`，否则滚动位置会使用旧高度。

## 验证

- 2026-11-13：`pnpm --filter @answra/cli test` 通过，15 个测试文件、88 个测试；新增覆盖：
  - `test/inputLayout.test.ts`：宽字符、emoji、换行、grapheme 移动、光标可视窗口、按显示行上下移动、短行夹取、Home/End 视觉行边界。
  - `test/virtualLayout.test.ts`：高度估算、可视窗口、底部偏移。
  - `test/wheelInput.test.ts`：SGR/X10 滚轮解析、跨 chunk 序列、鼠标 tracking 启停。
  - `test/tui.test.tsx`：底部跟随、PgUp 与滚轮滚动、运行中连续滚轮、流式追加时保持历史位置、Home/End 不抢 transcript、思考折叠与历史隐藏。
- 2026-11-13：输入布局上下移动修复了重复叠加行起始偏移的问题；宽字符/短行边界测试与 `pnpm --filter @answra/cli typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/cli build` 与 `node apps/cli/dist/main.mjs --version` 通过。
- 2026-11-13：`pnpm lint`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm notes:check` 通过。
- 2026-11-13：全仓并行 `pnpm verify` 在既有 `@answra/ui` 用例上出现 4 个 5s 超时/未及时渲染；`pnpm --filter @answra/ui test` 单独执行 43 文件、300 测试通过，本轮未改 `packages/ui` 运行代码。该抖动与 TUI 改动无直接关系，但全仓门禁仍需在低负载下复跑确认。
- 待完成：VS Code 集成终端实机验收（含滚轮与 Shift+拖选）。未完成前不能把本 Note 当作“所有交互已验收”的依据。

## 风险

- 估算高度与实测高度有偏差，快速拖动滚动时会出现轻微位置修正；通过测量回写和 overscan 控制。
- 终端宽度在 resize 时变化，清空缓存会造成一次重排；这是正确性优先的代价。
- `measureElement` 在测试环境中的时序与真实终端不同，虚拟列表测试可能较慢；用确定性等待而不是固定毫秒断言。
- 启用鼠标 tracking 后终端原生拖选会被接管；Shift+拖选是终端提供的转义，需在 VS Code 实机确认。若 VS Code/xterm.js 的 SGR 序列格式与预期不同，滚轮会静默失效而不是误输入。
- 思考/工具展开会显著增加可视内容高度；虚拟列表会承受，但极端大 diff 仍可能卡顿，后续再按工具类型做折叠。
