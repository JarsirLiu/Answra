# Note：设置面板额度细分说明字号缺失修复

状态：已实施

## 问题

桌面端设置面板「账户」页的额度细分说明（`福利 0 · 账户额度 96 积分 · 福利最近到期 …` 与订阅用户的 `本周期已用 …`）渲染成浏览器默认大字号（约 16px），与整个 11px/10px 令牌体系的面板排版严重脱节，用户反馈「怎么会字体啥的做的那么丑」。该行自 [桌面端登录后账号与额度同步](../feature/2026-10-19-desktop-auth-account-quota-sync.md) 引入细分说明时就缺失样式，属于纯 CSS 适配漏项。

## 根因

`SettingsPanel.tsx` 给这两行用了 `setting-quota-detail` 类名，但 `SettingsPanel.css` 里**从未定义**该规则——React 不报错、类型不报错，缺失只在实机可见。

## 修复

- 补齐 `.setting-quota-detail`：`color: var(--ink-soft); font-size: var(--font-xs); font-variant-numeric: tabular-nums; overflow-wrap: anywhere`，与 `.setting-quota-head` 的次要说明字号一致；`overflow-wrap: anywhere` 允许带日期的长福利说明换行。
- 规则上方留注释写明"此前漏写该规则即为此 bug"，防再次删除。

## 涉及范围

- `packages/ui/src/components/panels/SettingsPanel.css`：新增 `.setting-quota-detail` 规则；不触碰任何 TSX 结构与契约。
- 仅影响「账户」页额度区分细说明的两处 `<span>`（免费来源行、订阅周期已用行）；额度主行、进度条、徽章不受影响。

## 决定

- 显式给每个用到的类立规则，缺规则就要在实机上显眼地坏掉，而不是静默变好看；**舍弃**给 `.setting-quota` 整块写兜底 `font-size`——容器兜底会把"哪一行漏了规则"重新藏起来。

## 曾考虑的替代方案

- **在 `.settings-panel` 或 `.setting-quota` 容器层统一设 `font-size: var(--font-xs)`：** 容器兜底能让这一行"看起来正常"，但容器内其它元素（如未来新增的额度说明）再漏规则时又静默回落，且容器字号会覆盖进子控件默认值，与"字号只走四档令牌、逐元素声明"的既有写法不一致，舍弃。
- **给两行复用既有 `.setting-status` 类（同为 ink-soft + font-xs）：** 零新增规则，但额度明细还需要 `tabular-nums` 数字对齐与长日期换行，复用状态行类要么继续缺规则、要么把「登录状态提示」与「额度明细」两个语义绑死在一个类上，舍弃。

## 影响表面

- 账户页额度细分说明回到 10px（`--font-xs`）次要说明字号；免费用户与订阅用户的细分行各一处。

## 后果与防回退

- 约束：TSX 引用的每个自定义类名必须在配套 CSS 里有规则，CSS 与 TSX 同一变更提交，不允许"类名先行、样式后补"。（本批次后续把账户内容抽到 `AccountPanel.tsx/.css` 后，同一约束对 AccountPanel 生效。）
- 该缺陷无逻辑分支，属样式适配，不新增行为测试；验证以实机截图与 typecheck/lint 全绿为准。

## 验证

- `pnpm verify` 全绿；`packages/ui` vitest 通过（含账户页行为用例）。
- 实机：桌面端打开「设置 → 账户」，细分说明行与「可用积分」主行字号一致、不再撑爆面板。
