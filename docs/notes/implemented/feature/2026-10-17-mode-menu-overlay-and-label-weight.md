# Note：模式菜单改为浮层与界面标签统一字重

状态：已实施

## 问题

两个来自同一张实机截图的观感缺陷：

1. 打开「笔试 / 面试 / 会议」模式菜单时，下方内容面板被整体往下挤：菜单像是在文档流里占了一格高度，设置面板随之下移，用户明确要求「我希望是浮层，不要把设置面板这些往下挤」。
2. 菜单里的文字（如"笔试"）看起来比悬浮导航栏里的同名文字、以及设置面板的标题字更清晰，用户反问「是不是加粗了」——同一句话在胶囊里和菜单里字重不同，观感发闷、不统一。

## 涉及范围

- 代码/模块：`packages/ui/src/components/floating-bar/FloatingBar.tsx` / `.css`（菜单浮层）、`packages/ui/src/styles/tokens.css`（新增 `--label-weight`）、`packages/ui/src/components/floating-bar/ModePicker.css`、`WorkspaceControls.css`、`packages/ui/src/components/panels/PanelShell.css`、`SettingsPanel.css`、`NotesPanel.css`、`SourcesPanel.css`、`packages/ui/src/components/controls/SurfaceButton.css`。
- UI/进程/协议/持久化表面：**没有**窗口尺寸契约变化（`fitContent` 上报逻辑不变）、不动 IPC 与持久化；变化的只是外壳在"菜单打开 + 面板打开"这一组合下的自测高度，以及界面标签字重。
- 相关 Note：[变色龙只接管表面固有色](2026-10-17-ambient-surface-only-and-light-palette.md)（同批观感返工）、[输入框边界与功能图标可见性](../bug-fix/2026-10-17-ambient-control-outline-and-icon-legibility.md)。

## 根因

1. `.floating-bar-stack.is-menu-open` 无条件加 `padding-bottom: calc(var(--menu-item-h) * 3 + 18px)`。这条预留本身是为"面板关闭时窗口只有胶囊高，菜单会被窗口裁掉"准备的，但它对"面板已打开"的情况同样生效：`useFitContent` 测到的外壳高度 = 胶囊 + 预留 + 面板，于是面板被推下菜单高度。
2. 界面标签字重散落成 600 / 650 / 700（`h2` 用 UA 默认 bold）：`.mode-picker-trigger` 600、`.panel-title` 650、`.setting-row strong` 600、`.settings-panel h2` 未显式设置（bold）、`.destination-label strong` 600，而 `.mode-menu-item` 没有字重 → 继承 `button { font: inherit }` 的 400。同一句"笔试"在胶囊里是 600、在菜单里是 400，小字号下 600 会明显发糊。

## 决定

- 菜单**仅在面板关闭时**为窗口预留高度；面板打开时不再预留，菜单以 `position: absolute`（`top: calc(var(--bar-h) + 6px)`、`z-index: 3`）盖在面板上。面板（`min-height: 400px`）永远比菜单（3 项 ≈ 102px）高，因此盖住即可，不需要动窗口尺寸。
- 新增 `--label-weight: 500` 作为**界面标签唯一字重**：胶囊模式触发钮、菜单项、工作区目标名、面板标题、设置标题与分组标题、笔记/参考资料标签、主操作按钮一律引用它。正文内容（答案、笔记正文、消息流）不受此令牌约束。

## 影响表面

- 打开模式菜单不再改变窗口高度，面板不再位移；菜单覆盖在面板顶部，点击菜单外区域照旧关闭（`useDismissableOpen` 未变）。
- 面板关闭时行为不变：窗口仍会为菜单向下扩展，菜单不会被裁掉。
- 界面标签（导航栏、菜单、面板标题、设置标题/分组标题、按钮文字）统一为 500 字重：小字号不再发糊，同一句话在任何位置观感一致。
- 主操作按钮（如"保存"）仍靠薄荷绿实底强调，不再靠加粗。

## 曾考虑的替代方案

- **把菜单改成 Portal 到窗口外（真实弹出层）：** 需要新的窗口与 IPC，为一个 3 项菜单引入独立 HWND 不划算；绝对定位已经能达到"覆盖、不挤压"。
- **给菜单预留高度改为 `min-height` 而不是 `padding`：** 面板高度本就大于菜单，`min-height` 同样会改变外壳高度，等价于没修；正确做法是"面板打开时不预留"。
- **统一字重时两边都取 600：** 小字号 600 在浅色盘上明显发糊（本次正是用户抱怨的点），且导航栏文字会显得拥挤。
- **统一取 400：** 导航栏/标题会显得发飘、失去层级；500 是"有层级但不发糊"的折中。
- **逐处手写字重（不使用令牌）：** 本次缺陷就是手写值散落导致的，令牌化才能防止下次又漏一处。

## 后果与防回退

- `.floating-bar-stack.is-menu-open` 的预留高度**只能**在面板关闭时生效；改动菜单定位时必须回到"面板打开时窗口高度不变"这条验收线。
- 界面标签字重一律引用 `--label-weight`，禁止再出现 600/650/700 的字面量；新增面板标题、分组标题、按钮标签时同样引用它。
- 正文内容排版（`TextResponse`、`ReplyBar` 答案区、笔记正文）**不**使用 `--label-weight`，它们是内容不是界面标签。

## 验证

- `packages/ui/test/FloatingBarApp.test.tsx`：面板打开时打开模式菜单，外壳不带 `is-menu-open`（面板不被下推）；面板关闭时打开菜单，外壳带 `is-menu-open`（窗口为菜单让出高度）；菜单仍可被点击外部关闭且不关闭面板。
- `packages/ui` 全部 209 个测试通过；`pnpm verify` 通过。
- 待实机验证：面板打开时菜单压在面板之上、面板内容不位移；胶囊与菜单里的同名文字字重一致。
