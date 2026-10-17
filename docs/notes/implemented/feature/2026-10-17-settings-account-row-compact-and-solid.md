# Note：设置面板账户行收紧与行内主操作小号化

状态：已实施

## 问题

「账户」区块首版是「两行文字 + 居中实底薄荷大按钮」，用户先后反馈「这个登录也太丑了吧」「登录按钮还是背景颜色太大了」，第三轮又明确「登录按钮要有颜色，只是按钮不能这么大」。三句话合起来的真实诉求是：**品牌色必须保留，问题只在按钮尺寸**——实底薄荷块按全局控件的默认高度（`--ctl-h` 26px，settings 面板此前带 40px 最小宽、12px 横距）放进紧凑的行内场景显得过大，与同行开关/滑块/数值的视觉重量不成比例。同时未登录态下方还挂着一句解释文案「登录后由服务端下发会员能力」，按钮本身已表达意图，属冗余文案（用户原话：「这种经典 AI 解释，删了吧」）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/SettingsPanel.tsx`（账户区块 JSX、`accountHint`）、`packages/ui/src/components/panels/SettingsPanel.css`（`.setting-action` 尺寸档、`.setting-status`/`.setting-error` 分组内间距与规则顺序）。
- UI/进程/协议/持久化表面：纯设置面板表现层；登录链路（IPC、凭据、深链）与账户状态契约不变。
- 相关 Note：[桌面端账号登录与凭据（Phase 0）](2026-10-17-desktop-account-login-and-credentials.md)（账户区块的来源与状态语义）、[变色龙下的输入框边界与功能图标可见性](../bug-fix/2026-10-17-ambient-control-outline-and-icon-legibility.md)（控件描边/品牌令牌分工）、[模式菜单浮层与统一标签字重](2026-10-17-mode-menu-overlay-and-label-weight.md)（面板视觉重量统一的前例）。

## 决定

- 账户区块单行化：`<strong>` 显示账户状态/档位标题（未登录/已登录/免费档/会员/未知档位原样），右侧对齐行内动作按钮（登录/退出登录）。
- 登录/保存保持 **实底薄荷**（`variant="primary"` 原样，不加任何颜色覆盖）；第二轮一度改成「淡绿底+深绿字」的 tonal 款，用户第三轮明确"要有颜色"，tonal 覆盖整体撤回——**色块保留、尺寸收紧**。
- 行内动作统一 `.setting-action` 尺寸档：`min-width: 32px; height: 22px; padding: 0 8px; font-size: var(--font-xs)`，比全局 `--ctl-h` 再小一档，与开关、`85%` 数值同一视觉重量级。
- 未登录态不渲染任何解释文案；`accountHint` 仅在登录后返回能力摘要（`已解锁 N 项云能力` / `暂无可用云能力`），为空则不渲染 `<p>`。
- 分组内 `.setting-status` / `.setting-error` 去 `<p>` 默认段距（`margin: 0; padding: 6px 0 8px`），贴住所属行。
- `.setting-error` 基础规则移到高特异性的 `.settings-group > .setting-error` 之前，消除 biome `noDescendingSpecificity` 唯一警告。

## 曾考虑的替代方案

- **淡绿底 + 深绿字的 tonal 款（第二轮实际交付过）：** 用户看后要求恢复颜色实底——在登录这类转化入口上，tonal 会把行动号召感削得过分，已回退并保留拒绝原因：设置面板行内主操作不做 tonal。
- **改为 quiet 纯文本按钮（透明底 + `--muted` 字）：** 品牌色彻底消失，未登录时账户区块没有任何行动号召感；比 tonal 更弱，同理弃用。
- **未登录也保留一句说明文案：** 档位/能力本来就是登录后的服务端下发结果，未登录时这句话没有 actionable 信息，用户点名删除，不再变相恢复。
- **给登录按钮单独建一种 SurfaceButton variant：** 尺寸差异用位置选择器 `.setting-action` 覆盖即可；为高度差新增全局 variant 会把"主操作"样式分裂成两套。

## 影响表面

- 设置面板「账户」「模型」两组的行内主操作（登录/保存）为 22px 高的实底薄荷小按钮；「退出登录」仍是 quiet。
- 未登录时账户区块只剩「未登录 + 登录」一行，无说明行；登录后出现能力摘要行。
- 悬浮条、菜单、其余主按钮的 `--primary` 实底样式与尺寸不变（仍走 `--ctl-h`）。

## 后果与防回退

- 约束一：**设置面板行内主操作的品牌实底薄荷不可去掉**；若嫌视觉重量失衡，只能继续收紧 `.setting-action` 尺寸档，不得往 tonal/quiet 方向回退。
- 约束二：**登录/模型等区块未登录/未配置时不得新增"XX 后由服务端 XX"式解释文案**；状态行只承载真实状态与错误。
- 约束三：`pnpm lint` 在 `SettingsPanel.css` 保持 0 警告——新增更高特异性规则要放在对应基础规则之后（ascending）审视。

## 验证

- `packages/ui/test/FloatingBarApp.test.tsx` 37 项通过（含登录/退出登录/档位与能力摘要/未登录隐藏账户区块）。
- `packages/ui` 全量 29 个测试文件 216 项通过；`npx biome check` 对改动文件 0 警告；`pnpm verify` 全绿（含 notes:check 与架构守护）。
- 实机：用户按截图迭代三轮后确认——颜色保留（实底薄荷）、按钮缩小、解释文案删除。
