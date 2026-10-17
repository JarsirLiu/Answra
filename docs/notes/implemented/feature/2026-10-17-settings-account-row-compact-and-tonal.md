# Note：设置面板账户行收紧与行内主操作淡色化

状态：已实施

## 问题

「账户」区块首版是「两行文字 + 居中实底薄荷大按钮」，用户先后反馈「这个登录也太丑了吧」和「登录按钮还是背景颜色太大了」：在整列排布紧凑、控件重量统一的设置面板里，唯一的实底绿块把视觉重量全部吸走，与同行开关/滑块明显失衡。同时未登录态下方挂着一句解释文案「登录后由服务端下发会员能力」——按钮本身已表达意图，这类解释性文案是冗余（用户原话：「这种经典 AI 解释，删了吧」）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/SettingsPanel.tsx`（账户区块 JSX、`accountHint`）、`packages/ui/src/components/panels/SettingsPanel.css`（`.setting-action`、新增 `.setting-action.surface-control--primary` 淡色覆盖、`.setting-status`/`.setting-error` 分组内间距与顺序）。
- UI/进程/协议/持久化表面：纯设置面板表现层；登录链路（IPC、凭据、深链）与账户状态契约不变。
- 相关 Note：[桌面端账号登录与凭据（Phase 0）](2026-10-17-desktop-account-login-and-credentials.md)（账户区块的来源与状态语义）、[变色龙下的输入框边界与功能图标可见性](../bug-fix/2026-10-17-ambient-control-outline-and-icon-legibility.md)（控件描边/品牌令牌分工）、[模式菜单浮层与统一标签字重](2026-10-17-mode-menu-overlay-and-label-weight.md)（面板视觉重量统一的前例）。

## 决定

- 账户区块单行化：`<strong>` 显示账户状态/档位标题（未登录/已登录/免费档/会员/未知档位原样），右侧对齐行内紧凑动作按钮（登录/退出登录）。
- 行内动作按钮统一 `.setting-action`：`min-width: 40px; height: 26px; padding: 0 10px; font-size: var(--font-xs)`，与开关、`85%` 数值同一视觉重量档。
- **设置面板内 `variant="primary"` 的行内按钮改为淡色款**：`--mint-wash` 底 + `--mint-text` 字 + `--mint-line` 细描边、无投影；hover 加深为 `--mint-wash-strong`。实底薄荷（`.surface-control--primary`）留给悬浮条等真正的全局主操作位，全局样式不动。
- 未登录态不渲染任何解释文案；`accountHint` 仅在登录后返回能力摘要（`已解锁 N 项云能力` / `暂无可用云能力`），为空则不渲染 `<p>`。
- 分组内 `.setting-status` / `.setting-error` 去 `<p>` 默认段距（`margin: 0; padding: 6px 0 8px`），贴住所属行。
- `.setting-error` 基础规则移到高特异性的 `.settings-group > .setting-error` 之前，消除 biome `noDescendingSpecificity` 唯一警告。

## 曾考虑的替代方案

- **保留实底薄荷、只继续缩小尺寸：** 第一轮已把大按钮压成 26px 行内按钮，用户仍嫌绿块面积大——问题在实底色块本身，不在尺寸。
- **改为 quiet 纯文本按钮（透明底 + `--muted` 字）：** 品牌色彻底消失后，未登录时的账户区块没有任何行动号召感，且登录是注册转化入口，需要比普通行更强的可点暗示；淡绿底保留品牌色的同时把重量降到行内档。
- **未登录也保留一句说明文案：** 档位/能力本来就是登录后的服务端下发结果，未登录时这句话没有 actionable 信息，用户点名删除，不再变相恢复。
- **给登录按钮单独建一种 SurfaceButton variant：** 仅设置面板两处（登录/保存）需要淡色款，用位置选择器覆盖即可；新增 variant 会把"主操作"语义分裂成两种全局样式。

## 影响表面

- 设置面板「账户」「模型」两组的行内主操作（登录/保存）从实底薄荷变为淡绿底淡色款；「退出登录」仍是 quiet。
- 未登录时账户区块只剩「未登录 + 登录」一行，无说明行；登录后出现能力摘要行。
- 悬浮条、菜单、其余主按钮的 `--primary` 实底样式不变。

## 后果与防回退

- 约束一：**设置面板行内主操作不得恢复实底薄荷**；实底强调仅限悬浮条/菜单等全局主操作位，需要评审明确认可才可例外。
- 约束二：**登录/模型等区块未登录/未配置时不得新增"XX 后由服务端 XX"式解释文案**；状态行只承载真实状态与错误。
- 约束三：`pnpm lint` 在 `SettingsPanel.css` 保持 0 警告——新增更高特异性规则要放在此前对应的基础规则之后（ascending）审视。

## 验证

- `packages/ui/test/FloatingBarApp.test.tsx` 37 项通过（含登录/退出登录/档位与能力摘要/未登录隐藏账户区块）。
- `packages/ui` 全量 29 个测试文件 216 项通过；`npx biome check` 对改动文件 0 警告。
- 实机：用户按截图迭代两轮后确认（无实底绿块、无解释文案）。
