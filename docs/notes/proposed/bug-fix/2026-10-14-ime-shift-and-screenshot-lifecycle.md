# Note：内置输入法焦点生命周期与 Shift 切换

状态：提案

## 问题

用户反馈内置输入法可以组合中文，但不能像常见输入法一样按 Shift 切换英文；输入拼音尚未选词时使用外部截图工具，候选条会消失，截图结束后继续输入只能输入英文。截图由外部工具发起，不属于 Answra 的截图工作流；当前没有证据表明该操作关闭了 Answra 面板或卸载了 renderer。候选条本身还需要从当前拼音串起点对齐，并让右侧分页控件清楚可见。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx`、`packages/ui/src/components/panels/ImeCandidatePopup.tsx`、`apps/desktop/src/main/ime/rimeBridge.ts`、`apps/desktop/native/rime-host/main.cpp`、截图工作流及主/回复窗口生命周期。
- UI/进程/协议/持久化表面：键盘事件从 textarea 经 preload/IPC 到 librime；输入 owner 失焦、卸载和跨窗口切换；候选原生窗口可见性。
- 相关 Note：[IME 候选条使用独立原生窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)、[候选词窗口复刻微软拼音 UI 与 preedit 入框](../../implemented/feature/2026-10-14-ime-candidate-popup-windows-style.md)。

## 根因

- **Shift 切换（代码已确认）：** `useEmbeddedIme.sendKey` 在没有 composition 时拒绝所有非单字符键；composition 中虽会尝试发送 Shift，`rimeBridge.namedKey` 又没有 Shift_L/Shift_R 键码。因此 Rime `ascii_composer` 收不到独立 Shift 按键。这是 Answra 的转发缺口，不是已知的 librime 能力限制。
- **外部截图后恢复（现象确认，根因待实测）：** 外部截图工具改变系统前台焦点，候选消失后输入只能英文。代码存在共享 session 被多个 renderer 全局启停、helper disable 清空 composition 的风险，但还没有用户现场时序日志证明这是本次复现的直接根因。不能把外部截图等同于 Answra 关闭面板；需要观察原生 blur/focus、renderer lifecycle、owner/session 状态和候选窗口状态。
- **候选条布局（代码已确认）：** 上报的水平锚点取 textarea selection/caret 的 x，因此长 preedit 会让候选条跟着 caret 向右移动；禁用分页按钮 opacity 为 0.38，视觉上容易被误认为没有控件。

## 修复

按隐私与状态完整性优先级分批处理：

1. 候选条布局已在本次变更中改为 preedit 起点，并提高禁用分页控件的可见度；自动化测试覆盖坐标和按钮语义。
2. 生命周期与隐私架构见[输入法与窗口生命周期、隐私策略提案](../architecture/2026-10-14-ime-window-lifecycle-and-privacy.md)。该提案先定义 owner lease、原生焦点和 renderer 焦点、窗口策略生命周期及注销边界；本 Note 不再重复设计细节。
3. 生命周期实现稳定后再单独修 Shift 键码映射和 idle 状态按键转发，并在 Windows 11 实机确认。

## 提案

候选条可读性、输入法/窗口生命周期与隐私、Shift 切换分别处理。先锁定位置和候选分页行为；再依照[生命周期与隐私架构提案](../architecture/2026-10-14-ime-window-lifecycle-and-privacy.md)稳定 owner、焦点与窗口策略；最后单独接通 Shift keysym，避免同时改变输入状态机和按键语义。

## 修复顺序

分三批处理，避免 UI 定位、按键映射和多窗口状态生命周期同时变化：

1. **候选条可读性（本轮实施）：** 锚点改为当前 preedit 起点，分页按钮即使禁用也清晰可辨。Rime 状态、输入焦点和窗口生命周期不变。
2. **外部截图失焦、IME 所有权和隐私生命周期（下一批）：** 按独立架构提案实施并先用无内容日志验证 Windows 状态转移。外部截图只作为系统焦点切换场景，不假设 Answra 面板卸载。
3. **Shift 英文切换：** 生命周期实现稳定后，将左右 Shift 作为可发送的独立按键映射到 Rime Shift_L/Shift_R 键码，即使当前没有 preedit 也允许发送；保留修饰键掩码。先用 key translation 单测和 Windows 实机确认 `ascii_composer` 是否按预期切换，再决定是否需要把 ascii mode 暴露给 UI。

第二批有独立架构 Note 与测试；第三批 Shift 另行实施和记录。本 Note 只记录问题拆分，不代表行为已修复。

## 曾考虑的替代方案

- **Shift 直接在 renderer 切换到普通 textarea 输入：** 这会绕过 Rime 当前会话，未完成的 composition 和候选状态可能丢失；优先让 Rime `ascii_composer` 接收真实 Shift 按键。
- **截图开始时无条件清空 composition：** 能避免恢复不一致，但会丢掉用户尚未提交的拼音；除非确认 Rime 无法跨 owner 保留状态，否则不采用。
- **失焦时永远不隐藏候选窗口：** 候选可能残留在其他应用或外部截图画面上；失焦必须立即隐藏，只恢复输入 owner 和候选锚点。

## 验收标准

- 可观察结果：外部截图期间候选不出现在截图中；截图工具退出并切回 Answra 后，未提交拼音按明确策略保留或清空并回到中文模式，不会静默变成只能英文；重启、注销和窗口关闭后无残留候选窗，隐身保护覆盖所有相关窗口；随后按 Shift 可在中文/英文模式间切换；候选条从拼音起点显示，右侧分页状态可辨。
- 自动化验证：覆盖外部应用造成的 blur/focus 状态模型、当前 owner lease、迟到 cleanup、多窗口 enable/disable 顺序、renderer reload/crash、窗口关闭/重建、app quit、候选窗隐藏与捕获保护状态，以及 Shift key/code 翻译和空 composition 时按键发送。
- 需要的实机验证：Windows 11 外部截图工具前后台切换、截图取消/完成后恢复、renderer 重启、应用退出/再次启动、注销再登录；确认候选窗不泄露到截图、主窗/回复窗/候选窗的 capture protection 状态正确；再验证 Shift 中英切换与高 DPI/多显示器位置。

## 风险

- **Shift 事件：** Windows DOM 可能将实体按键报告为 `Shift` 或 `Process`；必须结合 `event.code` 归一化，不能只匹配 `event.key`。
- **Rime 状态归属：** 当前 main 侧是共享 librime session，而 main、回复窗口有独立 renderer；任意 renderer cleanup 都可能影响另一输入 owner。所有权与过渡必须在 main 侧串行化。
- **截图隐私和生命周期：** 外部截图程序不受 Answra 控制，不能假设其会通知应用。主进程必须在 Electron blur 时尽快隐藏候选窗；操作系统级捕获保护仍需按窗口类型应用和实测。系统级截图若在失焦事件之前捕获到一帧，应用侧无法承诺绝对阻止，需依赖已验证的 Windows 捕获保护策略。
