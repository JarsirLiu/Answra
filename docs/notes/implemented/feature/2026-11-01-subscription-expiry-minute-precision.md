# Note：套餐到期展示到分钟

状态：已实施

## 问题

账户页「套餐到期」使用 `toLocaleDateString()`，只显示日期。服务端额度接口已经下发 RFC3339 时间戳，网站也能展示到分钟，但桌面端把时刻截掉了，用户无法判断套餐在当天的具体失效时间。

## 涉及范围

- `packages/ui/src/components/panels/AccountPanel.tsx`：额度明细行的日期格式化。
- `packages/ui/test/SettingsPanelTabs.test.tsx`：分钟级展示的回归断言。
- `packages/shared/src/channels/auth.ts`：`AuthQuotaInfo.expiresAt` 契约不变，仍是 RFC3339 字符串。
- 相关 Note：[安装包功能裁切与发布 Profile](../architecture/2026-11-01-answer-only-release-profile.md)、[answer 安装包依赖裁剪](../simplification/2026-11-01-trim-answer-installer-runtime-deps.md)。

## 决定

只改渲染层展示，不改接口与数据模型：

- `套餐到期` 使用 `toLocaleString`，显式指定 `year/month/day/hour/minute`，按用户本地时区展示，例如 `2026/12/01 08:00`。
- 不显示秒：需求粒度是分钟，秒数没有决策价值，还会让行宽抖动。
- `福利到期` 仍按日期展示，保持原有粒度；本次只调整用户指出的套餐到期。
- `expiresAt` 为 `null` 时继续不渲染该行，不补默认时间。

## 影响表面

- 账户面板的额度卡新增一行分钟级时间，复用现有 `account-quota-row` 版式，不新增组件或样式。
- `daysRemaining` 仍保留为「剩余 N 天」摘要，与精确到期时间并存；两者来源不同，不互相推导。
- 主进程、preload、IPC 和云端协议无变化。

## 曾考虑的替代方案

- **后端直接下发格式化好的字符串：** 舍弃。协议应保留 RFC3339 原值，格式化属于展示层；否则不同客户端无法按本地时区呈现。
- **引入 date-fns / dayjs 处理时间：** 舍弃。只有一处日期时间格式化，`Intl`/`toLocaleString` 已足够，新增依赖会增加安装包和测试成本。
- **同时显示秒和时区：** 舍弃。需求只要到分钟；秒级信息对套餐失效判断没有意义，时区由本地系统决定即可。
- **福利到期也一并改到分钟：** 舍弃（本次范围外）。福利积分是赠送额度，日粒度已满足当前展示；若产品确认需要，再按同一规则扩展。

## 后果与防回退

- 到期时间按运行机器的本地时区展示；跨时区用户看到的是自己的本地时刻，而不是服务端时区。
- 服务端若退化为只发日期（如 `2026-12-01`），界面会显示当天 `00:00`；这是输入事实，渲染层不猜测服务端时区。
- 测试断言行内必须出现 `HH:mm` 且不得出现秒，防止后续把格式化改回 `toLocaleDateString`。
- `expiresAt` 为空时不显示该行，避免用 `daysRemaining` 反推具体时间。

## 验证

- `pnpm --filter @answra/ui test`：`SettingsPanelTabs.test.tsx` 覆盖套餐到期包含分钟且不含秒。
- `pnpm verify`、`pnpm notes:check` 通过。
- 需在登录后的账户页实机确认：套餐到期行显示本地日期与 `HH:mm`，窄面板下不折行。
