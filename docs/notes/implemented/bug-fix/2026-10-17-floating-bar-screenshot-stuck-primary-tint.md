# Note：截图入口常驻底色与超宽间距

状态：已实施

## 问题

悬浮条第 2 段里「截图提问」按钮常驻淡薄荷底色 + 内描边，看起来像一直处于 hover 态；同时该按钮 `min-width: 52px`、图标居中对齐，左右留白明显大于同排的「AI 对话」，同一排按钮没有统一规格。

## 涉及范围

- 代码/模块：`packages/ui/src/components/floating-bar/FeatureActions.tsx`、`packages/ui/src/components/floating-bar/FeatureActions.css`、`packages/ui/test/FloatingBarApp.test.tsx`。
- UI/进程/协议/持久化表面：悬浮条第 2 段「模式功能」按钮的视觉规格（仅 UI 表现层，不涉及 IPC 与持久化）。
- 相关 Note：[悬浮表面视觉契约](../architecture/2026-10-11-floating-surface-visual-contract.md)、[悬浮条单一笔记本入口与导航图标统一尺寸](../simplification/2026-10-17-floating-bar-single-workspace-entry-and-icon-size.md)。

## 根因

`SurfaceButton` 的 `variant="primary"`（`.surface-control--primary`：品牌薄荷实底 + 对比文字 + 阴影，供「发送/保存/选择文件」等确认类按钮）与本地 `feature-action--primary`（淡底 + `inset` 描边 + `min-width: 52px`）同时作用于截图按钮。两个选择器优先级相同，而 `FeatureActions.css` 在样式表中位于 `SurfaceButton.css` 之后，本地覆盖获胜，于是截图按钮拿到「淡绿常驻底 + 52px 宽」，既不是确认类实底按钮，也不是普通图标按钮。

## 决定

删除这层特殊化：截图入口与同排其它模式功能一律是普通图标按钮（`variant="default"`、无 `feature-action--primary`）；确认类实底样式仍由 `SurfaceButton` 的 `primary` 变体独占，悬浮条不再保留任何按钮级样式特例。

## 修复

- `FeatureActions.tsx`：去掉 `feature-action--primary` 类名与 `SurfaceButton` 的 `variant="primary"` 传参，模式功能按钮统一走默认变体。
- `FeatureActions.css`：删除 `.feature-action--primary` 与 `.feature-action--primary:hover` 两条规则（含 `min-width: 52px`、薄荷淡底、`inset` 内描边）。
- `FloatingBarApp.test.tsx`：新增用例，断言第 2 段两个模式功能按钮的 class 完全一致、都带 `surface-control--default`、都不含 `primary`。

## 影响表面

- 悬浮条第 2 段所有模式功能按钮规格一致：`min-width: var(--ctl-min-w)`（26px）、`padding: 0 var(--ctl-pad-x)`（7px）、透明底色，仅 hover 出现 `--hover` 底色，激活态仍是 `--mint-wash`。
- 截图提问不再常驻底色与内描边，宽度与「AI 对话」等宽。
- `.surface-control--primary`（实底薄荷）语义不变，回复条发送、设置保存、工作区选择文件不受影响。

## 曾考虑的替代方案

- **保留 `variant="primary"` 实底、去掉本地覆盖：** 会把主操作做成品牌色实心按钮，与同排纯图标按钮并列时规格仍不一致，且截图不属于「确认类」动作，因此不采用。
- **保留淡底但只在 hover / 激活时出现：** 与通用 hover 底色重复，等于为单个按钮加特例，收益只是「看起来特别」，因此不采用。
- **只缩小 `min-width`、保留常驻底色：** 仍保留「卡住的 hover 底」观感，问题只解决一半，因此一并移除。

## 后果与防回退

- `feature-action` 不允许再出现按 `action.id` 判定的样式特例（`--primary` 之类）；模式功能按钮的规格由 `.feature-action` 一处决定。
- 需要区分「确认类主操作」时使用 `SurfaceButton` 的 `variant="primary"`，不要再叠加组件级覆盖样式。
- 新增按钮样式前需确认选择器优先级与样式表加载顺序，避免两个同优先级语义类互相覆盖。

## 验证

- 新增 `packages/ui/test/FloatingBarApp.test.tsx` 用例：第 2 段两个模式功能按钮 class 完全一致、都带 `surface-control--default`、都不含 `primary`。
- `packages/ui` 全部 206 个测试通过；`pnpm verify` 通过。
