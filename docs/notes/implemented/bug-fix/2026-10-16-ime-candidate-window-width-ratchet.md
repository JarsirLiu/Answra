# Note：候选窗宽度棘轮导致候选词显示不完整

状态：已实施

## 问题

内置输入法组字时，候选条只显示第一个候选的一部分（用户截图：`1 你是` 后直接是翻页箭头），其余候选看不到；重启 `pnpm dev` 后一度无法复现，用户判断为"间歇性"。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ImeCandidatePopup.css`、`packages/ui/src/app/ImeCandidateWindowApp.tsx` / `.css`、`packages/ui/test/ImeCandidateWindowApp.test.tsx`。
- UI/进程/协议/持久化表面：候选窗 renderer 的内容测量与 `ImeCandidateChannels.Fit` 上报；主进程 `imeCandidateWindowController` 的尺寸状态；不涉及 Rime 会话、lease、focus 或持久化。
- 相关 Note：[候选词窗口复刻微软拼音 UI 与 preedit 入框](../../implemented/feature/2026-10-14-ime-candidate-popup-windows-style.md)、[IME 候选条使用独立原生窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)。

## 根因

候选窗尺寸由 renderer 测量后上报主进程，而测量结果本身被**当前窗口宽度**夹住，形成只能变窄的棘轮：

1. `.ime-candidate-popup` 的上限是 `max-width: min(640px, calc(100vw - 16px))`。这是 overlay 时代（`5a9d4d2`，候选条还在主窗口内）的写法；`2ea2c46` 把候选条迁到独立候选窗后，`100vw` 变成**候选窗自身宽度**。
2. `ImeCandidateWindowApp` 用 root 的 `getBoundingClientRect()` 上报尺寸。root 是 `width: max-content`，而 popup 的 max-width 已经按窗口宽度夹过，于是上报值 = `min(真实内容宽, 当前窗口宽)`。
3. 结论是窗口宽度单调不增：某次候选集较窄（或候选为空、仅有 preedit 时 popup 几乎不占宽）会把窗口收窄；之后候选变多时，renderer 报回的仍是窗口宽度本身，主进程 `resize()` 只会重排不会变宽。`imeCandidateWindowController` 的 `size` 在窗口复用期间不重置，所以只有窗口重建（重启应用回到 `INITIAL_SIZE` 640）才恢复 —— 与"重开面板/重启后偶发、无法复现"的观察一致。
4. 视觉表现由裁剪决定：popup `overflow: hidden`、`.ime-candidate-options { overflow-x: auto; min-width: 0 }`，被压缩后候选整条裁掉，只剩固定 52px 的翻页控件仍然可见。

"重开对话面板"本身不是原因，只是开启新一轮组合；尺寸是跨组合残留的状态。

## 决定

候选窗的内容测量必须与窗口当前尺寸无关：renderer 负责上报"内容自然尺寸"，主进程只负责把窗口位置和上限夹进所属 display 的 work area。

## 修复

- `ImeCandidatePopup.css`：上限改为常量 `max-width: 640px`，并加 `flex: 0 0 auto`，避免 popup 作为 root 的 flex 子项被压缩。
- `ImeCandidateWindowApp.css`：root `overflow: auto` → `hidden`。它仍是 scroll container，可读出溢出内容；同时避免窗口偏小的一帧在透明窗上闪出滚动条。
- `ImeCandidateWindowApp.tsx`：上报 `Math.max(rect, scrollWidth/scrollHeight)`，窗口偏小时也能报出未裁剪的内容尺寸。
- 主进程不改：`imeCandidateLayout.ts` 继续按 display work area 夹紧宽高、下方空间不足时隐藏，这是唯一允许的外部上限。
- 测试：`packages/ui/test/ImeCandidateWindowApp.test.tsx` 新增 1 项 —— root 矩形 160×52、scroll 尺寸 472×72 时，`fitImeCandidate` 必须上报 472×72。

## 曾考虑的替代方案

- **保留 `100vw` 上限，在主进程加"最小宽度"兜底：** 舍弃。真实内容宽度只有 renderer 知道，主进程的兜底值只能拍脑袋，长候选仍会被裁。
- **主进程按候选文本长度估算宽度：** 舍弃。宽度取决于字体、字号、注释和 DPI，renderer 测量是唯一准确来源，另写一套估算会长期漂移。
- **把 popup 改成绝对定位元素再测量：** 舍弃。绝对定位子元素不参与父元素尺寸，需要另写测量代码；`flex: 0 0 auto` + scroll 尺寸已等价。
- **候选窗改用现成的 `useFitContent`：** 舍弃。它读 `offsetWidth/offsetHeight`，同样被裁剪夹住，会复制同一棘轮；候选窗需要 scroll 尺寸语义。

## 后果与防回退

- 凡"窗口尺寸 = renderer 测量内容"的 surface，测量结果不得依赖当前窗口尺寸（`100vw`/`vh`/`%`/`flex-shrink`）；上限只能是常量或主进程的 work area 夹紧。
- `useFitContent`（主悬浮栏、回复栏）读的是 `offsetWidth/offsetHeight`；若这些面出现"尺寸只能变小"的同类现象，按同一思路换成 scroll 尺寸。
- 主进程 `size` 故意不在每次组合时重置（否则每次显示都会闪一帧默认尺寸），因此 renderer 上报的正确性是唯一保证，回归测试必须保留。

## 验证

- 定向：`pnpm --filter @answra/ui test -- --run ImeCandidateWindowApp ImeCandidatePopup`，2 个文件 / 9 项通过。
- 全量：`pnpm verify` 通过（UI 24 个文件 / 159 项，desktop 26 个文件 / 135 项，app 7 项；Biome lint、Note 门禁、各包 typecheck、architecture check 全部通过）。
- 待实机验证（用户）：先打短候选再打长候选（例如先 `ni` 再 `ni shi shui`），以及关闭/重新打开 AI 对话面板后继续打字，确认候选条宽度跟随候选内容恢复且不再被裁。
