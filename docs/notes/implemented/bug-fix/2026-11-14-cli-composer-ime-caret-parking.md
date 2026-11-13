# Note：CLI 输入框把终端硬件光标停到 IME 插入点

状态：已实施

## 问题

全屏 TUI 里中文输入法的候选窗跟随终端硬件光标。Ink 默认把硬件光标留在整帧输出末尾，输入框中段光标只靠反色块模拟，因此拼音预编辑和候选窗会出现在屏幕底部而不是输入框位置，用户无法确认正在输入的内容。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/composer/inputLayout.ts`：新增 `CellPosition` 与 `cursorCellAt(layout, origin)`，把可视光标行列换算成相对 Ink 输出原点的单元格；上方省略号占一行时计入。
  - `apps/cli/src/tui/composer/TextInput.tsx`：用 `useRef<DOMElement>` + `useBoxMetrics` 测量输入框原点，`measureElement` 取绝对位置，再用 `useCursor().setCursorPosition` 停放硬件光标；未测量或宽度为 0 时隐藏光标。反色块假光标保留。
  - `apps/cli/test/inputLayout.test.ts`、`tui.test.tsx`：单元格换算单测与真实终端光标列断言的集成测试。
- UI/进程/协议/持久化表面：只改 CLI 终端输入框的光标位置，不改克隆自 transcript、Agent 事件、IPC 或持久化。
- 相关 Note：
  - [CLI 输入光标导航与对话鼠标选区（对齐 Claude Code）](../feature/2026-11-13-cli-input-navigation-and-transcript-selection.md)
  - [CLI 输入框全选、剪切与单行上下移动](../feature/2026-11-14-cli-input-selection-and-line-navigation.md)

## 决定

输入框自己声明终端硬件光标位置：用 Ink 8 的 useBoxMetrics 判断测量就绪，measureElement 取原点，cursorCellAt 换算单元格，useCursor().setCursorPosition 停放；反色块假光标保留，两者同源。

## 根因

Ink 8 的 `log-update` 只在显式声明的光标位置输出 `cursorTo`；未声明时硬件光标停在帧尾。输入框此前只有 `TextInput` 内部的反色块，没有调用 `useCursor`，所以 IME 看到的插入点始终是帧末。

## 修复

- 输入框根 `<Box>` 挂 `ref`，`useBoxMetrics` 给出布局信息的就绪信号，`measureElement` 给出相对输出原点的 `x/y/width`。
- 光标单元格 = 输入框原点 + (`layout.cursorLine - layout.startLine` + 上方省略号行, `layout.cursorColumn`)；宽字符列宽来自 `layoutInput` 的显示宽度。
- 布局未测量或宽度为 0 时传 `undefined` 隐藏硬件光标，避免停在错误位置。
- 反色块继续作为视觉光标；它和硬件光标位置一致，不引入第二套坐标。

## 曾考虑的替代方案

- **移植 Claude Code 的 Ink fork / `declared-cursor`：** 舍弃。参考树是 source map 还原产物，整段移植会引入维护和许可证风险；Ink 8 公开的 `useCursor` 已能满足。
- **每帧手动输出 `CSI H` 定位：** 舍弃。会绕过 Ink 的增量渲染与擦除逻辑，和 `incrementalRendering` 冲突。
- **只保留反色块假光标：** 舍弃。假光标是应用内绘制，不移动终端硬件光标，IME 候选窗仍错位。
- **按字符数而不是显示宽度换算列：** 舍弃。中文/emoji 占两列，会导致候选窗偏移。

## 后果与防回退

- 输入框根 `<Box>` 必须保留 `ref` 与 `useBoxMetrics`；删除后 IME 候选窗会回到帧尾。
- 光标换算只能走 `cursorCellAt`，不得在组件内另写行列公式。
- 未测量时不得猜测原点；宁可隐藏硬件光标，也不能停在旧位置。
- 假光标与硬件光标必须使用同一 `layout.cursorLine/cursorColumn`，否则选区与 IME 会出现两套位置。
- 升级 Ink 时先跑 `tui.test.tsx` 的光标列断言与实机中文输入。

## 验收标准

- 可观察结果：输入 `a` 后输入 `中`，终端硬件光标列前进 2；拼音预编辑与候选窗出现在输入框内。
- 自动化验证：`apps/cli/test/inputLayout.test.ts` 的单元格换算；`apps/cli/test/tui.test.tsx` 从 ANSI 输出提取 `cursorTo` 列号并断言宽字符 +2。 
- 需要的实机验证：Windows Terminal / VS Code 集成终端下切换中文输入法，确认候选窗位置。

## 验证

- 2026-11-14：`tui.test.tsx` 30 项、`inputLayout.test.ts` 12 项通过；`typecheck`、`biome check`、`build` 通过。
- 2026-11-14：真实 OpenAI 兼容端点（NVIDIA）流式请求返回 `content: OK`；CLI 非交互与 `pnpm dev:cli` 均输出 `OK`，确认修复期间没有回归模型链路。
- 待完成：Windows Terminal / VS Code 集成终端的中文输入法实机走查。

## 风险

- `measureElement` 依赖 Ink 的 Yoga 布局；首帧未测量时硬件光标短暂隐藏，输入后恢复正常。
- 部分终端不把硬件光标用于 IME 候选窗定位，修复只能改善支持该行为的终端。
- 扫描/增量渲染下光标位置随可见窗口变化；上方省略号行已计入，但隐藏行较多时需要实机确认。
- 停止输入或失焦后硬件光标仍停在最后插入点，由终端自身处理，本改动不做额外隐藏。
