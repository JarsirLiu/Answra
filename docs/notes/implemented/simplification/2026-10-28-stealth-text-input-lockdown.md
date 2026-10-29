# Note：主线隐身模式文本输入收缩

状态：已实施

## 问题

主线文本输入与隐身窗口的原生 `focus`/`blur` 生命周期耦合。当前阶段无法证明窗口在隐身切换、捕获和窗口重建期间始终不会重新获得焦点；继续允许文本目标聚焦会形成不可控的输入表面。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useStealthInputGuard.ts`、两个 renderer 入口、`apps/desktop/src/main/windowSurfaceRegistry.ts`。
- UI/进程表面：隐身模式下的对话、回复条和工作区文本目标。

## 决定

主线隐身模式不提供聚焦打字。renderer 在隐身状态启用 fail-closed 文本输入保护，所有文本目标拒绝 `focusin`、`pointerdown`、键盘和 composition；main/reply 原生窗口同时使用 `setFocusable(false)`，关闭隐身后再恢复可聚焦。普通模式仍由系统输入法处理文本。

## 移除内容

- 移除主线隐身下文本目标的聚焦例外，避免输入入口绕过输入锁。

## 重新引入条件

- 未来重新引入隐身打字前，必须先完成可验证的 focus/blur 生命周期契约、跨平台实机捕获验证和对应 UI/main 回归测试；在此之前不得恢复例外或 renderer 入口的 guard 绕过。

## 曾考虑的替代方案

- **只在 renderer 中阻止文本事件：** 舍弃。原生窗口仍可能被重新激活，不能作为底层防线。
- **只在 BrowserWindow 层设置 `setFocusable(false)`：** 舍弃。窗口层策略不能阻止 renderer 内部脚本或组件继续调用文本目标的 `focus()`，必须由 renderer guard 同步拒绝输入事件。

## 验收标准

- 可观察结果：隐身模式下所有文本输入框不能获得焦点、不能响应键盘或 composition；按钮等非文本控件仍可操作；关闭隐身后普通模式文本输入恢复。
- 自动化验证：`useStealthInputGuard` 覆盖普通文本目标；窗口 surface 测试覆盖隐身时 `setFocusable(false)` 与关闭后的恢复。
- 需要的实机验证：Windows/macOS 上切换隐身、显示回复条和窗口重建后确认窗口不能获得原生焦点。

## 后果与防回退

隐身模式暂时不能输入文字，用户只能使用已有的截图、语音和非文本操作。任何新增文本目标必须继承全局 guard，不能自行调用 `focus()` 绕过策略。

## 验证

本次变更通过 UI guard 单测与 TypeScript 检查；原生 `setFocusable` 行为仍需 Windows/macOS 实机验证。
