# Note：CLI 滚动锚定的文本选区

状态：已实施

## 问题

CLI 的全屏 transcript 只能对“当前屏幕已渲染的行”做鼠标拖选：

- 任何滚动都会把选区清空：`VirtualTranscript` 的 wheel/PageUp/PageDown 直接调用 `onScroll`，而 `App` 把 `onScroll` 接到 `onClearSelection`。
- 拖拽到视口上/下边缘不会继续滚动，无法像普通终端一样按住鼠标连续上滑/下滑扩选。
- 选区以屏幕行号为锚点，滚出视口的行随即从可复制快照里消失；即使用户在滚动后仍能看到高亮，复制内容也不完整。
- 拖拽释放依赖 `pointerInput` 的 release 事件，但没有独立的拖拽生命周期，自动滚动无法在释放时可靠停止。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/interaction/selectionStore.ts`：选区改为内容行坐标，增加 viewport、拖拽状态、行缓存与自动滚动方向。
  - `apps/cli/src/tui/interaction/useDragAutoScroll.ts`（新增）：拖拽到视口边缘时的自动滚动节拍。
  - `apps/cli/src/tui/interaction/selectionActions.ts`：release 时结束拖拽。
  - `apps/cli/src/tui/transcript/SelectableText.tsx`：按内容行登记与高亮。
  - `apps/cli/src/tui/transcript/VirtualTranscript.tsx`：统一 `scrollBy`、注入 viewport、冻结测量、内容变化时重置缓存。
  - `apps/cli/src/tui/app/App.tsx`：移除“滚动即清空选区”的接线。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；选区是进程内短暂状态，不落盘、不进协议、不影响 SQLite/session 存储。
  - 仍要求 alternate screen；非全屏模式继续使用终端原生选区。
- 相关 Note：无直接前置；与 2026-11-17 CLI 图片粘贴 Note 同属输入/终端交互，但互不依赖。

## 决定

### 选区坐标

- 选区锚点与焦点保存为**内容行**：`contentRow = scrollTop + screenRow - viewportTop`。
- 屏幕行只在两个边界换算：指针事件进入 store 时、`SelectableText` 登记/高亮时。
- 滚动时内容行保持不变，所以高亮自然随文本移动；不需要滚动时逐行平移选区。
- 拖拽期间焦点额外跟随鼠标：`shiftViewport(delta)` 把焦点内容行加上滚动 delta，使焦点停在原屏幕行，选区向新滚出的内容扩展。

### 行缓存

- `commitFrame()` 不再替换已登记行，而是把当前帧行并入持久 `lines` 缓存；`visible` 只保留当前帧用于点击命中。
- 滚出视口的行仍留在 `lines`，因此滚动后复制选中范围不受虚拟窗口影响。
- 消息数组、压缩边界或布局 key（终端宽度、transcript 模式、工具展开）变化时调用 `resetContent()`，同时清空选区与缓存。

### 自动滚动

- 拖拽焦点在视口上/下边缘且位于锚点外侧时，每 50ms 滚动 2 行；到达滚动边界、释放或选区清除即停止。
- 设置 200 tick 上限，防止 release 事件丢失后无限滚动。
- 滚轮与 PageUp/PageDown 统一走 `scrollBy`，选区不再被清空。

### 布局稳定

- 选区存活期间冻结新挂载项的高度测量，避免测量更新改写内容行坐标；选区清除后再把排队的高度一次性刷入。
- 内容变化仍会清空选区，不在流式 token 增长时维持高亮。

### 明确不做

- 不做双击选词、三击选行或 Shift+方向键扩展；本次只解决鼠标拖选与滚动。
- 不改终端原生选择；alternate screen 下仍由应用接管鼠标。
- 不做跨进程/重启恢复选区。
- 不改变软换行复制策略：目前仍按屏幕行以 `\n` 连接，后续可通过 `softWrap` 标记合并。

## 影响表面

- 拖住鼠标向上/向下越过 transcript 视口边缘时，内容持续滚动且选区扩大。
- 滚轮、PageUp/PageDown 滚动时选区保留，复制文本仍包含滚出屏幕的已选行。
- 拖拽释放后停止自动滚动，保留高亮并复制。
- 消息更新、窗口 resize、展开工具、切换 transcript 模式会清空选区。
- 选区只在当前 CLI 进程内存在，不影响 SQLite 持久化或其他客户端。

## 曾考虑的替代方案

- **照搬 Claude Code 的 `scrolledOffAbove/Below` 累积器：** 舍弃。它针对只有屏幕缓冲的实现；我们的虚拟列表已经有 `scrollTop` 和 `contentOffsetY`，内容行坐标 + 行缓存更直接，也避免反向滚动的累积器债务逻辑。
- **滚动时平移 anchor/focus 的屏幕行：** 舍弃。每滚动一行都要修正两个端点、处理 clamp 与反向滚动，容易在虚拟窗口变化时错位。
- **滚动即清空选区，只保留“全选当前屏幕”：** 舍弃。这是现状，无法满足用户按住拖拽连续扩选的核心需求。
- **在拖拽开始时把整段 transcript 渲染成纯文本快照：** 舍弃。会强制渲染全部消息、放大内存与首帧成本，且破坏虚拟列表。
- **自动滚动放在 `selectionActions`：** 舍弃。actions 只认识指针事件，不知道视口高度和滚动边界；滚动节拍应靠近 transcript 视口。

## 后果与防回退

- `begin/extend/hasLine` 的入参是屏幕行；store 内部必须换算成内容行。新增指针入口不得绕过 store 直接写 anchor/focus。
- 任何会改变内容行含义的布局变化必须调用 `resetContent()`；只清选区不缓存会造成复制错行。
- 行缓存只能在纯滚动期间保留；消息/布局变化后必须清空，禁止把旧内容行与新布局混用。
- `useDragAutoScroll` 的 tick 必须防止重入：`shiftViewport` 会同步通知订阅者，未加 `ticking` 守卫会递归滚动。
- 选区存活期间冻结测量是刻意的取舍；如果未来需要在选区期间实时重排，必须同时设计内容行到新布局的映射，不能直接移除冻结。

## 验证

- `pnpm --filter @answra/cli test`：58 个测试文件、371 个测试通过。
- 新增/扩展：
  - `test/tui/interaction/selectionStore.test.ts`：内容行换算、滚动后缓存保留、拖拽焦点随视口移动、`resetContent` 清空。
  - `test/tui/transcript/dragScrollDirection.test.ts`：上/下边缘方向、视口内不滚动、释放后不滚动。
  - `test/tui/transcript/selectableText.test.tsx`：带滚动偏移时按内容行登记。
  - `test/tui/transcript/tui.transcript.test.tsx`：滚轮保留选中文本；拖拽到上边缘后自动滚动并保留选区。
- `pnpm --filter @answra/cli typecheck` 与目标文件 `biome check` 通过；仓库全量 typecheck 当时仍被并行中的 SQLite transcript 改动阻塞，与本次 TUI 改动无关。
- 未做真实终端实机验证；自动滚动、缓存与方向由单元/集成测试覆盖，Windows Terminal 手感需实机确认。
