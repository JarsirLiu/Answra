# Note：界面窗口标题统一为 Answra

状态：已实施

## 问题

系统托盘/任务栏悬浮预览显示的应用名是「笔试助手」，与安装名、`productName`（均已是 "Answra"）不一致；用户要求对外名称只保留 Answra 一个。

## 涉及范围

- 代码/模块：`apps/desktop/index.html`（窗口 `<title>`）。
- UI 表面：Windows 托盘/任务栏悬浮预览的标题、窗口标题（Electron 未显式设置标题时取 HTML title）。
- 相关 Note：命名决策与 [产品方向与 Agent 底座规划](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md) 中的品牌口径一致。

## 决定

- `index.html` 的 `<title>` 从 `笔试助手` 改为 `Answra`；main/preload 不显式覆盖标题，托盘与任务栏预览随之统一。
- 命名唯一来源收敛为 `productName`（electron-builder 配置）与窗口标题两处事实，均为 "Answra"；不再出现第三个显示名。

## 影响表面

- 托盘图标悬浮提示、任务栏窗口预览标题、窗口标题栏（如显示）统一为 Answra。
- 中文界面其余文案不受影响（按钮/菜单等 UI 文案本来就是中文）。

## 曾考虑的替代方案

- **在 main 里给窗口显式 `setTitle("Answra")`：** 舍弃。与 HTML title 双事实来源，改 HTML 一处即可。
- **保留「笔试助手」作为中文展示名：** 舍弃。用户明确要求只用 Answra，且双名称会再次分叉。

## 验收标准

- 可观察结果：托盘/任务栏悬浮预览标题为 Answra。
- 自动化验证：`pnpm notes:check`、`pnpm verify` 通过。
- 需要的实机验证：安装包内悬浮托盘图标确认提示文本。

## 验证

- `pnpm notes:check` 通过。
- 实机：安装 `pnpm dist:win` 重打后的安装包，悬浮托盘图标确认提示文本为 Answra。

## 风险

- 无已知风险：仅显示名变化，不涉及任何进程/协议行为。

## 后果与防回退

- 后续新增窗口（如面试独立窗口、设置二级窗口）默认会继承各自 HTML title，必须同样使用 "Answra"，不允许再造「笔试助手」等别名。
- 若未来需要本地化显示名，应统一走 `productName`/窗口标题的单一配置，而不是在多处硬编码。
