# Note：IME 输入目标 blur 与窗口失焦顺序

状态：已实施

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts` 与 `packages/ui/test/useEmbeddedIme.test.tsx`。
- UI/进程/协议/持久化表面：renderer DOM 焦点、Electron 窗口焦点和 main 持有的 Rime owner lease；不改变 IPC 协议或持久化。

## 问题

移除 IME 模式派生的 textarea `readOnly` 后，用户输入一个拼音字母，Rime 已返回 `handled: true` 和活动 preedit，但输入目标随即 blur 并释放 lease，导致之后按键不再进入 Rime。日志中 lease release 先于 main window blur。

## 根因

renderer 曾在 DOM blur 后用 150ms 定时器、renderer `window.blur` 状态和 `document.activeElement` 决定是否发送 `releaseTarget`。Electron 原生窗口失焦通知晚于 renderer DOM blur 时，定时器可能先运行，把窗口级焦点交接误判为用户在窗口内离开输入框；main 日志因此出现按键成功后先 `lease-released`、再 `main-window-blur`，composition 被 reset。HTML `readOnly` 的存在与否不应影响 lease 生命周期。

## 决定

DOM blur 不释放 lease，也不推断窗口生命周期；它只关闭该编辑器的 renderer 按键门。main 侧原生窗口生命周期单独 suspend/resume lease。普通 DOM 焦点变化不隐式发送 release；控件卸载、IME 禁用和 renderer 明确切换目标才触发 owner 生命周期变化。不得用定时等待或 `document.hasFocus()` 推断原生窗口焦点。

## 修复

- `useEmbeddedIme.blur` 关闭当前 editor 的 renderer 按键门并记录诊断，不发送 `releaseTarget`。
- 移除全局 `pointerdown`/`focusin` 到 lease release 的隐式通道；hook 卸载仍释放自身 lease。
- 窗口恢复时只对仍有 generation 且 DOM 仍聚焦的 target 发送 focus confirmation，不从窗口焦点创建新 owner。
- 回归测试覆盖 DOM blur 先于 native window blur、焦点转到普通控件时保留 lease 并停止旧 editor 按键路由，以及窗口恢复不夺取编辑器焦点。

## 曾考虑的替代方案

- **每次 DOM blur 后延迟 release：** 舍弃。固定延迟无法保证 Electron renderer 与原生窗口事件的先后顺序，仍可能先于 main 的 suspend 释放 lease。
- **全局监听任意焦点/鼠标事件并释放 lease：** 舍弃。它把 DOM 焦点、窗口激活与输入目标生命周期重新耦合；renderer coordinator 仅在明确目标切换时失效旧队列并清理旧 generation。

## 后果与防回退

- input blur 只表示该 DOM editor 暂不接收键盘事件，不等于输入目标释放或窗口失焦。
- renderer `window.focus` 只可确认一个仍存在的 target generation；只能由编辑器 focus/acquire 建立新 owner。
- 候选定位模块只读取当前 editor 和 selection 几何，禁止恢复、转移或模拟 DOM 焦点。

## 验证

- 定向验证：`pnpm --filter @answra/ui test -- useEmbeddedIme.test.tsx ImeCandidateAnchorReporter.test.tsx`，2 个文件、26 项通过。
- 全量验证：`pnpm verify` 通过；UI 158 项、desktop 129 项、app 7 项测试通过，typecheck、Note 门禁、Biome 和 architecture check 通过。
- Windows/macOS 原生窗口焦点行为尚未实机验证；自动化测试不证明候选窗口激活和系统焦点时序。
- 原生复测：Windows/macOS 交互尚待用户验证；自动化测试覆盖 DOM blur 先于 native window blur，不证明平台焦点切换全矩阵通过。
