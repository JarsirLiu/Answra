# Note：隐身模式光标覆盖被同特异性规则压过

状态：已实施

## 问题

隐身模式要求界面操作（输入、按钮、文档工具栏等）始终保持系统默认箭头，避免指针形状暴露"正在输入或选择"。但 `base.css` 的 `[data-stealth="true"]` 覆盖特异性仅 (0,2,0)，组件里若干 `cursor` 声明与之同分或更高，胜负交给源顺序：排在 `base.css` 之后的组件规则会胜出，隐身模式下重新出现 pointer 手型。没有任何自动化守卫覆盖这条约束，因此属于可静默回归的缺陷。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/base.css`（`[data-stealth="true"]` 光标覆盖）、`packages/ui/test/themeCss.test.ts`（CSS 完整性守卫）。
- UI/进程/协议/持久化表面：renderer 内 `<FloatingBarApp/>`（`.overlay-root`）与 `<ReplyBarWindowApp/>`（`.reply-window-root`）根节点下所有元素的光标外观；不改 `window.setContentProtection`，不改窗口、焦点、IME 与持久化行为。
- 相关 Note：[综合隐身模式提案](../../proposed/architecture/2026-10-13-comprehensive-stealth-mode.md)（§5 指针处理边界）、[静默捕获与排除提案](../../rejected/feature/2026-10-10-silent-capture-and-exclusion-proposal.md)。

## 根因

- 覆盖选择器 `.overlay-root[data-stealth="true"] *` 与 `.reply-window-root[data-stealth="true"] *` 的特异性均为 (0,2,0)，声明是普通 `cursor: default`，没有任何优先级加成。
- 组件里的 `cursor` 声明会追平或超过它。`message-actions` 之外的 `ThinkingReasoning.module.css` 中 `.trHeader.isClickable` 恰好是 (0,2,0)；同特异性下由源顺序决定，CSS modules 的打包顺序排在 `base.css` 之后即胜出。`.x button:hover:not(:disabled)` 一类则是 (0,3,1)，一旦声明 `cursor` 会直接压过覆盖。
- 覆盖的意图是"任意后代恒为默认箭头"，普通声明无法表达"恒胜出"这一语义。

## 决定

- 覆盖声明改为 `cursor: default !important`，让本规则对任意后代 `cursor` 规则恒胜出；作用域仍限定在 `[data-stealth="true"]`，正常模式下零影响。
- 不逐组件补 `[data-stealth]` 子选择器，也不移除组件自身的 `cursor` 声明。

## 修复

- `packages/ui/src/styles/base.css`：隐身覆盖加 `!important`，并把"必须 `!important`"的原因写进注释。
- `packages/ui/test/themeCss.test.ts`：新增守卫，断言两个隐身根选择器存在且覆盖声明为 `cursor: default !important`。

## 曾考虑的替代方案

- **逐组件补 `[data-stealth]` 子选择器：** 舍弃。每新增一个带 `cursor` 的控件都要补一条，正是本次缺陷的成因——新控件会静默漏掉，约束无法收敛到单点。
- **反复叠加属性或 `:not()` 抬高覆盖特异性：** 舍弃。需要预先超过一个未知上限，写法晦涩，而且仍会被更高的组件规则追上。
- **移除组件里的 `cursor` 声明：** 舍弃。这些声明在正常模式下是正确且必要的交互提示，为隐身牺牲常规体验不可接受。

## 后果与防回退

- 隐身模式的光标外观现在由 `base.css` 一处持有，新增组件无需知道隐身约束；代价是引入仓库首个 `!important`，其作用域被 `[data-stealth="true"]` 严格限制。
- 若重命名 `.overlay-root` / `.reply-window-root` 或新增第三个隐身根节点，必须同步更新 `base.css` 与 `themeCss.test.ts`，否则该根节点下的指针不再受约束。
- 本修复只保证 UI 自绘的光标形状；不改变"系统指针由 OS 合成器绘制、`setContentProtection` 不覆盖指针"这一事实，也不改变会议软件自身共享光标设置的影响。

## 验证

- 自动化：`pnpm --filter @answra/ui test -- --run test/themeCss.test.ts` 通过（3/3）。把覆盖改回普通 `cursor: default` 后该用例失败（负向验证）。
- 全库扫描：遍历 `packages/ui/src/**/*.css` 的 19 条 `cursor` 声明，无一高于 (0,2,0)；最高为 `.trHeader.isClickable` 的 (0,2,0)，即本次同分取胜路径的实例。
- 需要的实机验证：Windows/macOS 隐身模式下悬停可点击控件（思考块标题、工作区文档工具栏按钮等），指针保持默认箭头。
