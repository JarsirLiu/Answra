# Note：面试引导卡片在 fit-content 窗口里滚动收缩

状态：已实施

## 问题

切换到面试引导或制作态后，窗口高度会随内容滚动/重排逐步收缩，严重时卡片底部和页脚被裁掉。用户感知为“滚动一下窗口就变小了”。

## 涉及范围

- 代码/模块：`packages/ui/src/interview/onboarding/onboarding.css`
- 测试：`packages/ui/test/themeCss.test.ts`
- UI 表面：面试引导三步卡片、面试分身制作态卡片；主窗口 fit-content 高度链路
- 相关 Note：
  - [账户面板 vh 上限在 fit-content 窗口里引发塌缩](2026-10-24-account-panel-vh-max-height-collapse.md)
  - [面试前引导与候选人档案首次使用流程](../../proposed/feature/2026-11-11-interview-onboarding-and-avatar.md)
  - [Shell fit-content 与浮窗](../../implemented/architecture/2026-10-10-shell-fit-content-and-surfaces.md)

## 根因

主窗口是 fit-content 透明窗：`useFitContent` 观察 `.overlay-root` 的 `offsetHeight` 并通过 `fitContent` 上报，主进程据此设置窗口高度。

面试卡片直接挂在 `.overlay-root` 下，却把自身高度写成：

```css
height: min(34rem, calc(100vh - var(--bar-h) - var(--space-6)));
```

这里 `100vh` 就是窗口高度，而窗口高度又由卡片内容上报决定，形成自引用回路：窗口先变小 → `100vh` 变小 → 卡片高度上限变小 → 上报更小 → 窗口继续收缩。卡片同时写了 `min-height: 0`，没有像 `.content-panel` 的 `min-height: 400px` 那样提供循环地板。

宽度也有同类隐患：

```css
width: min(var(--surface-w, 40rem), calc(100vw - var(--space-4)));
```

正常布局下 `--surface-w` 会先成为宽度地板，`100vw` 上限通常不生效，但它仍让视口单位参与 fit-content 宽度上报，属于同一类自引用风险。

## 修复

- 删除面试卡片的 `100vh` / `100vw` 基准约束。
- 高度改为固定 `34rem`；卡片内部继续用 `.interview-onboarding-body` / `.interview-avatar-body` 的 `flex: 1; min-height: 0; overflow-y: auto` 滚动。
- 宽度继续跟随 `--surface-w`，并保留 `40rem` 上限：`width: min(var(--surface-w, 40rem), 40rem)`。
- 超出工作区时仍由主进程 `clampToWorkArea` 处理，不在渲染层复制视口上限。

## 决定

- 面试引导/制作态卡片高度固定为 `34rem`，宽度跟随 `--surface-w` 并以 `40rem` 封顶。
- 卡片内部承担滚动，主进程 `clampToWorkArea` 承担工作区钳制；渲染层不再用 `vh` / `vw` 参与 fit-content 尺寸上报。

## 曾考虑的替代方案

- **保留 `100vh`，给卡片加固定 `min-height` 地板：** 舍弃。地板只能让循环提前触底，仍保留视口单位参与高度上报；不同屏幕下地板值还会与真实可用高度打架。
- **保留 `100vh`，改用 JS 测量窗口高度再写内联高度：** 舍弃。只是把自引用从 CSS 搬到 React，仍然由窗口高度反向决定内容高度，并增加一层状态同步。
- **把卡片高度改为 `auto`，完全由内容撑开：** 舍弃。引导/制作态需要固定卡片轮廓和固定页脚；`auto` 会让不同步骤高度跳动，也会把长项目列表重新变成窗口无限长。
- **宽度保留 `100vw` 上限：** 舍弃。当前布局下通常不触发，但它和高度问题同源；既然已经明确 fit-content 窗口内不使用视口单位，就不留第二个隐患。

## 验收标准

- 可观察结果：
  - 进入面试引导、切换三步、滚动项目列表或展开简历粘贴框时，窗口高度不再逐步收缩。
  - 卡片底部页脚始终可见；内容超出时在卡片内部滚动。
  - 制作态卡片同样稳定，不被 `100vh` 回路影响。
- 自动化验证：
  - `themeCss.test.ts` 增加守卫：面试卡片规则不得出现 `100vh` / `100vw`，高度为固定 `34rem`，宽度走 `--surface-w`。
  - 运行 `pnpm --filter @answra/ui test -- themeCss.test.ts`、UI typecheck、Biome、`notes:check`。
- 需要的实机验证：
  - Windows 11 下打开面试入口，切到项目页滚动列表，确认窗口高度稳定、页脚不被裁切。

## 风险

- 固定 `34rem` 在极矮工作区会被主进程钳制，卡片底部可能被裁；这是主进程 `clampToWorkArea` 的既有语义，和账户面板处理一致，不在渲染层重新引入视口上限。
- 如果未来需要“卡片随可用高度自适应”，必须先设计一个不参与 fit-content 上报的外部高度来源，不能直接恢复 `100vh`。

## 后果与防回退

- fit-content 窗口内，面试卡片及后续同类顶层卡片不得用 `vh` / `vw` 定义参与上报的 `height` / `width`；需要上限时用固定值或交给主进程 `clampToWorkArea`。
- 卡片必须保持固定高度 + 内部滚动（`min-height: 0` + `overflow-y: auto`），不能靠视口上限裁切内容。
- `themeCss.test.ts` 的守卫会阻止 `100vh` / `100vw` 重新进入面试卡片规则。

## 验证

- `pnpm --filter @answra/ui test -- themeCss.test.ts`：18 项通过，新增守卫覆盖卡片高度/宽度与内部滚动。
- `pnpm --filter @answra/ui test -- InterviewOnboardingPanel.test.tsx`：8 项通过，引导三步、跳过、重开行为未受影响。
- `pnpm --filter @answra/ui typecheck`、`pnpm tokens:check`、Biome 通过。
- 实机待验证：Windows 11 下打开面试入口，切到项目页滚动列表，确认窗口高度稳定、页脚不被裁切。
