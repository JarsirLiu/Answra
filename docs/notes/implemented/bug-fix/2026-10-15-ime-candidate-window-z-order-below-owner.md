# Note：候选窗口 z 序低于 owner 导致输入法候选条被 composer 按钮遮挡

状态：已实施

## 问题

在回复栏多轮对话面板中输入拼音时，候选词条（原生候选 BrowserWindow）被输入框右侧的发送按钮和中英切换按钮盖住：按钮浮在候选条之上。候选窗口是独立原生 surface，DOM z-index 无法跨窗口生效，因此这是原生窗口 z 序问题，而非 CSS 层叠问题。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/windowSurfaceRegistry.ts`、`apps/desktop/src/main/ime/imeCandidateWindowController.ts`、`apps/desktop/test/windowSurfaceRegistry.test.ts`。
- UI/进程/协议/持久化表面：Windows 上 ime-candidate 候选窗口与其 owner（main / reply-bar）的原生 z 序关系。
- 相关 Note：[窗口表面状态管理](../architecture/2026-10-15-window-surface-state-management.md)、[IME 候选原生窗口](../feature/2026-10-14-ime-candidate-native-window.md)。

## 根因

- `positionAndShow()` 在候选窗口已可见时走 "already-visible" 早退分支，后续重新定位从不重新断言 z 序。
- `reconcileAbove()` 只做 `setParentWindow` + `setAlwaysOnTop(true, "pop-up-menu")`。Windows 上 Electron 将 floating / pop-up-menu / screen-saver 都映射到同一 `HWND_TOPMOST` 层级带，重复设置 alwaysOnTop 等级不会保证 owned 子窗口排在 owner 之上；owner 被 `setBounds` 或重新激活后，Windows 不会自动把 owned 子窗口重新顶起，owner 内的 DOM（发送按钮、中英切换按钮）因此显示在候选条之上。

## 决定

在 `reconcileAbove()` 中追加 `child.moveAbove(owner.getMediaSourceId())` 显式压序：owned 关系建立或重申时，候选窗口必须排在 owner 之上。`positionAndShow()` 的 "already-visible" 分支在返回前调用 `host.attachAbove(window, source)` 触发同一路径，保证每次重定位都重申 z 序。

## 修复

- `windowSurfaceRegistry` 的 `attachAbove()` 在建立 owner 关系并设置 always-on-top 后调用 `moveAbove()`，明确将候选窗口排在 owner 之上。
- 候选窗口控制器在已显示窗口重新定位前重新执行 `attachAbove()`，避免可见状态下 owner 改变 z 序后候选条仍落在其下方。
- 自动化测试验证 `moveAbove()` 收到 owner 的媒体源标识。

## 曾考虑的替代方案

- **仅依赖 `setParentWindow` 的 owned 窗口语义：** 舍弃。Windows 上 Electron 对两个可见窗口改父子关系与 alwaysOnTop 等级并不能可靠抬高子窗口，实机已复现遮挡。
- **给候选窗口设更高 alwaysOnTop 等级（如 screen-saver）：** 舍弃。同一 TOPMOST 带内等级不产生相对顺序，还会影响与其他 overlay（如 selection-overlay）的层级语义。
- **把候选条渲染回 owner 窗口内部 DOM：** 舍弃。原生窗口方案是为了跨出 owner 边界显示（贴屏边、裁剪、capture 保护），回退 DOM 会破坏既有架构决定。

## 后果与防回退

- 候选窗口每次 attach / reconcile / 重新定位都会执行 `moveAbove`，开销为一次原生 SetWindowPos，可忽略。
- `windowSurfaceRegistry` 测试断言 `attachAbove` 后候选窗口以 `window:<ownerId>` 调用 `moveAbove`；若未来重构移除该调用（例如误以为 setParentWindow 足够），测试会失败提醒 Windows z 序回归。

## 验证

- 自动化：`pnpm --filter @answra/desktop exec vitest run test/windowSurfaceRegistry.test.ts test/imeCandidateWindowController.test.ts` 全部通过（10/10），其中 registry 测试新增 `moveAbove` 断言。
- 实机：Windows 上在多轮对话面板输入拼音，候选条应完整显示在发送按钮与中英切换按钮之上；该验证需用户实机确认，自动化测试无法覆盖 Electron/Windows 原生 z 序表现。
