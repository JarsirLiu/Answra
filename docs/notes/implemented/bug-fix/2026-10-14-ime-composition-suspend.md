# Note：输入法组合期间候选状态只能暂停，不能清除

状态：已实施

## 问题

用户使用外部截图工具切走焦点后，独立候选窗消失；恢复 Answra 并继续键入时，候选窗仍会再次消失。第一组日志显示 Rime 的按键仍被处理，`composing: true` 且 `candidateCount: 5`。后续日志又确认候选窗先收到 `owner-suspended`，随后 renderer 触发 `imeEnable(false)` 并收到 `enabled: false`。因此根因包括 renderer hook cleanup 错误地关闭了 main 进程共享的 Rime 会话；输入法不是自行切到英文，而是共享会话被关闭后失效。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx`、`apps/desktop/src/main/ime/imeCandidateIpc.ts`、`apps/desktop/src/main/ime/imeCandidateWindowController.ts`
- UI/进程/协议/持久化表面：renderer 上报组合快照，main 校验后控制独立候选窗口；不改变 Rime 组合本身。
- 相关 Note：[输入法焦点生命周期与 Shift 切换](../../proposed/bug-fix/2026-10-14-ime-shift-and-screenshot-lifecycle.md)、[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)

## 根因

`useEmbeddedIme` 把 renderer 组件 cleanup 当成了 Rime 会话终止，调用全局 `imeEnable(false)`。截图导致面板/输入组件生命周期变化时，这会关闭 main 进程持有的共享会话；该 hook 同时服务主窗口和回复窗口，任一 renderer 卸载都不应结束其他 renderer 共用的引擎。候选协议还把“候选暂空”与“组合结束”都表示为 `clear`，会额外丢掉候选 owner。插入光标可见性不能解释 `imeEnable(false)` 日志。

## 决定

Rime 会话由 main 进程持有，renderer cleanup 只解除订阅，不管理共享引擎寿命。显式切换关闭仍可请求 disable；应用退出由 main 调用 `dispose()`。候选组合期间的暂态空状态只暂停候选 UI，不能结束会话。

## 修复

- renderer 以 `ImeState.composing` 判断输入会话是否仍活跃。组合期间候选或 preedit 暂时为空时保留 main 已有候选状态，不发送 `suspend` 或 `clear`；有有效锚点后重新发送 show。非组合状态才发送带状态快照的 `clear`。
- main 收到带有 `enabled && composing` 的 clear 快照时降级为 suspend，避免 renderer 的展示状态清理掉仍活跃的 Rime 组合。
- IPC 校验 clear 中可选的状态快照，沿用 show 状态相同的结构校验。
- `useEmbeddedIme` 在 effect cleanup 时只清除 renderer 监听和重试定时器，不再发送全局 disable；用户显式关闭仍由状态变更触发 disable。
- main IME IPC 只允许最近启用 session 的 BrowserWindow 发键、选词和 reset；非所有者或无效请求返回空状态，不能通过错误请求关闭共享 Rime session。

## 曾考虑的替代方案

- **失焦时直接重置 Rime：** 舍弃。日志证明 Rime 仍有有效组合和候选；重置会丢失用户输入，并把窗口显示问题误当成引擎问题。
- **失焦时保持候选窗可见：** 舍弃。候选可能出现在外部截图或其他应用上，失焦仍需隐藏候选面板。
- **只自动聚焦 textarea：** 舍弃。焦点恢复不应决定 Rime 组合是否清理；强制聚焦也可能抢回用户在截图工具中的焦点。

## 后果与防回退

- 候选窗可以在失焦时隐藏，在 owner 恢复焦点和锚点后重新显示；renderer 卸载不再关闭共享 Rime 会话，只有显式关闭或 app 生命周期终止才结束引擎。
- 未来不得用“候选数组为空”单独推断 Rime composition 已结束；该判断必须使用 `ImeState.composing`。
- 此修复不解决 Windows 是否向 renderer 恢复 textarea 焦点，也不代表外部截图后的完整实机问题已验证。renderer 重启、owner lease、多窗口共享 Rime session 和注销边界仍由生命周期提案覆盖。

## 验证

- 自动化：`useEmbeddedIme` 覆盖 renderer hook 卸载时不关闭 main-owned Rime；`ImeCandidateAnchorReporter` 覆盖组合活跃但候选暂空或锚点暂缺时不清除候选；candidate controller 覆盖带活跃组合状态的 clear 只隐藏、不释放 owner，并可由后续 show 恢复。IME IPC 覆盖窗口 owner 隔离和无效调用不关闭 session。
- 自动化：运行 `pnpm notes:check`、`pnpm verify` 与 `git diff --check`。
- 实机：当前未在 Windows 外部截图工具中复测。用户日志来自 Windows 11 22631，但不足以证明补丁后的焦点/候选恢复行为。
