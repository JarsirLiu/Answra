# Note：桌面端账户面板积分向下取整显示错误

状态：已实施

## 问题

服务端发放 15 积分福利后，桌面端「账户」页显示「可用积分 14 积分 / 福利积分 14」，而管理后台显示 15。用户看到两个端数字不一致，误以为福利没有到账。

## 根因

网关按 USD 存储额度（`CreditsPerUSD = 720`），15 积分落库为 `0.02083333`，回算后是 `14.9999976`。桌面端 `AccountPanel` 对所有积分使用 `Math.floor`，把浮点尾差直接截断成 14；管理后台此前已改为四舍五入 + 夹紧非负，所以两端不一致。

## 修复

- `packages/ui/src/components/panels/AccountPanel.tsx` 新增 `displayCredits(value) = Math.max(0, Math.round(value))`。
- 可用积分、福利积分、账户额度、订阅已用/总额四处展示统一走 `displayCredits`，与 Web 端 `displayCredits` 口径一致。
- 负余额（如 `-0.00117014`）展示为 0，不把浮点尾差或欠款外露给用户。

## 涉及范围

- 仅影响桌面端「账户」页额度数值格式，不改服务端契约、不改扣费逻辑。
- 覆盖免费档（可用/福利/账户额度）与订阅档（本周期已用/总额）。

## 决定

- 展示层负责取整，服务端继续保留 USD 精度用于计费；不在网关侧把额度四舍五入后回写，避免计费精度丢失。

## 曾考虑的替代方案

- **服务端返回前取整：** 会让 API 的额度字段失去精度，且计费、对账仍需要原始 USD，前端各端还要各自处理格式，舍弃。
- **继续 `Math.floor` 但先加 epsilon：** 需要为每个数值挑一个魔法 epsilon，边界仍不可控；舍入语义也不统一，舍弃。

## 影响表面

- 桌面端账户面板：`14.9999976` 显示为 `15`，`-0.001` 显示为 `0`。
- 订阅档已用/总额同样按整数展示，与既有整数用例兼容。

## 后果与防回退

- 所有面向用户的积分展示必须先取整再夹紧非负；禁止直接 `Math.floor` 浮点额度。
- 新增用例 `rounds fractional credit balances and never renders negative credits` 锁定 15→15、负值→0 的行为。

## 验证

- `pnpm --filter @answra/ui test -- SettingsPanelTabs`：13 个用例通过（含新增用例）。
- `pnpm --filter @answra/ui typecheck`：通过。
