# Note：打开账户面板时同步云端额度

状态：已实施

## 问题

桌面端账户面板只在进程启动或登录态变化时拿到额度快照。管理员在网页端发放福利、用户在其他端消耗积分后，桌面端必须重启应用才能看到新数字；福利到期时间等展示也可能停留在旧快照。

## 决定

- 新增 `AuthChannels.Sync`（`answra:auth:sync`）与 `DesktopBridge.syncAuthStatus`，由 main 进程强制拉取一次账号与额度。
- `AuthService.syncStatus()`：access token 有效时只调用 `refreshDirectory`（能力目录 + 账号 + 额度），不消耗 refresh token；已过期时复用现有 `refresh()` 的刷新与冷却路径；失败时回退本地缓存，不影响登录态。
- `SettingsPanel` 在每次切到「账户」Tab 时调用 `syncAuthStatus`，返回结果直接更新面板；同时已有的 `onAuthStatus` 推送仍作为兜底。

## 额度与日期的来源

- 可用积分、福利积分、账户额度、套餐周期均来自网关 `GET /api/v1/user/quota` 的响应，客户端不读取余额金额、不在本地推算。
- 福利到期时间来自该响应的 `welfare_expires_at`（UTC RFC3339 字符串），桌面端只用 `toLocaleDateString()` 按本地日历格式化，不自行计算到期日。
- 因此「福利到期 2026/11/30」是云端下发的日期，不是桌面端按发放时间加 30 天算出来的。

## 曾考虑的替代方案

- **定时轮询额度：** 面板关闭时也会持续请求网关，浪费请求且无法保证打开瞬间最新，舍弃。
- **把 `getStatus` 改成每次都联网：** 会改变启动、公告、模型调用等所有调用点的语义，并让非账户场景也承担网络延迟，舍弃。
- **只在主窗口获得焦点时刷新：** 能覆盖大部分场景，但用户不切窗口、只切 Tab 时仍看到旧值，舍弃。

## 涉及范围

- `packages/shared/src/channels/auth.ts`、`packages/shared/src/bridge.ts`：新增同步频道与 bridge 方法。
- `apps/desktop/src/main/auth/authIpc.ts`、`authService.ts`、`src/preload/index.ts`：main 侧强制同步与转发。
- `packages/ui/src/components/panels/SettingsPanel.tsx`：账户 Tab 打开时触发同步。
- 不改服务端接口与计费逻辑。

## 后果与防回退

- 账户 Tab 每次打开会多 3 个只读请求（capabilities / profile / quota），属于用户主动打开面板的低频操作；access token 有效时不走 refresh 端点。
- 同步失败保留旧快照并保持登录态，不得因额度拉取失败把用户登出。
- 测试：`SettingsPanelTabs` 验证每次切到账户 Tab 都调用同步并展示新额度；`authService` 验证 `syncStatus` 不发 refresh 请求、直接更新 quota。

## 验证

- `pnpm --filter @answra/ui test -- SettingsPanelTabs`：14 个用例通过。
- `pnpm --filter @answra/desktop test -- authService`：38 个用例通过。
- `pnpm typecheck`、`pnpm exec biome check`：通过。
