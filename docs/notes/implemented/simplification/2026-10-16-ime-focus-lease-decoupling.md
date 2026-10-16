# Note：IME 焦点与输入目标职责拆分

状态：已实施

## 问题

输入目标 blur、Electron 窗口激活、main owner lease 和候选锚点曾通过全局事件互相驱动。普通鼠标点击或候选 UI 的窗口恢复可能释放 lease 或把焦点塞回编辑器，使输入中断且难以追踪责任边界。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx` 及其测试。
- UI/进程/协议/持久化表面：renderer DOM 焦点和输入路由；不修改 main IPC、Rime session 或持久化。
- 相关 Note：[IME 输入目标 blur 与窗口失焦顺序](../bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md)、[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)。

## 移除内容

- 移除 `useEmbeddedIme` 对全局 `pointerdown`/`focusin` 的监听及其隐式 `releaseTarget` 路径。
- DOM blur 只关闭该 editor 的 renderer 按键路由；窗口失焦由 main 生命周期 suspend，二者都不释放 owner。
- 窗口恢复只对 DOM 仍聚焦且 generation 仍有效的 target 发送 `resume`，不以窗口焦点创建新 owner。
- 候选锚点 reporter 不保存并恢复上次 editor 焦点。它只观察当前活动元素、selection 和布局。
- renderer `imeInputTargetCoordinator` 仍作为本 renderer 的队列路由门；main manager 仍是跨窗口唯一 lease 权威。两者不是两个可互换的 owner。

## 决定

编辑器焦点、原生窗口焦点、renderer 输入路由 target 和 main Rime lease 各自只由对应层持有。跨层只能通过显式 acquire、resume、release 命令建立因果关系；候选展示与普通 DOM 焦点观察不触发 lease 生命周期。

## 曾考虑的替代方案

- **保留全局鼠标/焦点监听并补更多目标过滤：** 舍弃。过滤规则仍需要把普通控件、候选 surface、窗口切换和编辑器焦点拼成一个推断器，职责会继续交叠。
- **窗口恢复时恢复上次输入框焦点：** 舍弃。候选展示或窗口激活不能代表用户要求改变 DOM 焦点；编辑器自己负责通过真实 focus 事件重新 acquire。

## 后果与防回退

- 普通焦点变化后 owner lease 可以仍存在，但失焦编辑器的 renderer 按键门关闭；再次聚焦该 editor 时由其 `focus` 路径 resume。切换到另一个 IME target 时仍按 generation 清理旧 composition。
- 重新引入全局 focus/pointer 监听前，必须证明其只发布事实、不直接取得/释放 owner，并由焦点状态所有者单独消费。
- 候选定位和展示代码不得调用 DOM `.focus()`，也不得 acquire/release IME target。

## 重新引入条件

- 只有平台实测证明 renderer 无法通过编辑器 focus 事件恢复既有输入目标时，才可增加恢复协作；必须由独立焦点协调模块报告事实，不得让候选锚点模块调用 `.focus()`。
- 如需窗口内普通控件聚焦时立即清除组合，应增加显式的编辑器退出命令并定义取消语义，不能恢复全局 pointer/focus 到 lease release 的隐式通道。

## 验证

- 自动化：测试 DOM blur 保留 lease 并阻止后续旧 editor key route；候选 reporter 在窗口 focus 时不改变 `document.activeElement`。
- 完整门禁：`pnpm verify` 通过；UI 158 项、desktop 129 项、app 7 项测试通过，typecheck、Note 门禁、Biome 和 architecture check 通过。
- Windows/macOS 原生焦点行为仍需实机确认；自动化测试不能替代。
