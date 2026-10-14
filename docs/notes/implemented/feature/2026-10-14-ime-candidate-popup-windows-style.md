# Note：候选词窗口复刻微软拼音 UI 与 preedit 入框

状态：已实施

## 问题

内置 Rime 输入法的候选窗口最初把拼音 preedit 单独画在浮窗顶部，而输入框内看不到正在组合的拼音；候选条本身也带上下翻页箭头、页码、选中项"灰底+左侧竖条"样式，与 Windows 微软拼音的候选条观感差距大，用户反馈"打字时 UI 不对"。

## 涉及范围

- `packages/ui/src/components/panels/ConversationComposer.tsx`：textarea 展示值拼接 preedit。
- `packages/ui/src/components/panels/ImeCandidatePopup.tsx` / `.css`：候选窗结构重排与微软拼音样式。
- 测试：`packages/ui/test/ImeCandidatePopup.test.tsx`、`packages/ui/test/ConversationComposer.test.tsx`。

## 决定

1. preedit 不再显示在候选窗里，而是直接拼接在 textarea 的展示值末尾（`value + state.preedit`，仅展示层，不写入 draft），与原生输入法的组合文本体验一致；候选窗仅在无候选时以内联文本兜底显示 preedit。
2. 候选窗复刻微软拼音横向候选条：左侧蓝色竖条（`::before` + `--accent`）、编号+词条横排、选中项整块浅色高亮（accent 18% 混色）、右侧仅保留 ◀ ▶ 两个翻页按钮（分别映射 PageUp/PageDown）；移除上下翻页、左右选择、页码与分隔控制区。

## 真实替代方案及舍弃理由

- 用 absolutely 定位的镜像层在 textarea 内绘制 preedit：可以支持光标不在末尾的组合，但当前 IME 模式下 textarea 只读、组合只发生在文本末尾，镜像层复杂度高收益为零。
- 继续在浮窗内画 preedit 并加下划线动画模拟"输入框内"：视觉欺骗，无法随输入框滚动/换行，被否决。
- 完整复刻微软拼音右侧的表情/设置/展开功能区：依赖不存在的功能入口，仅保留翻页，样式语言（竖条、高亮块、间距、圆角）已对齐。

## 后果

- preedit 属于纯展示，`onValueChange`/draft 仍只接收 committedText，发送、字数统计等逻辑不受影响。
- 键盘翻页（PageUp/PageDown）行为不变；候选窗按钮语义从"左/右选择"变为"上/下翻页"，测试同步更新。
- 若未来支持 preedit 内嵌光标（如句中组合），需改为镜像层方案。

## 验证

- `pnpm --filter @answra/ui test -- --run ImeCandidatePopup ConversationComposer`：2 个文件 9 个用例全部通过（含 preedit 入框断言 `toHaveValue("已输入ni shi shui")`、候选窗不含 preedit 行、翻页按钮路由 PageUp/PageDown）。
