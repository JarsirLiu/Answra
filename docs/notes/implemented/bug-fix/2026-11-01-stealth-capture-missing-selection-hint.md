# Note：隐身模式截图缺少可选区提示

状态：已实施

## 问题

隐身模式点击截图后，选区 overlay 完全透明，光标又被约束为系统默认箭头，用户看不到任何“已进入框选”或“需要拖拽”的提示。普通模式至少还有十字光标，隐身模式没有任何视觉反馈，容易被误判为截图没有触发。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/capture/selection.html`、`selectionWindow.ts`、`apps/desktop/test/selectionWindow.test.ts`。
- UI/进程/协议/持久化表面：区域截图 overlay 的提示与光标所在显示器的定位；不改截图裁剪、IPC、焦点策略和捕获保护策略，不改持久化。
- 相关 Note：[会议场景隐身模式的窗口与捕获边界](../../proposed/architecture/2026-10-13-comprehensive-stealth-mode.md)、[隐身模式光标覆盖被同特异性规则压过](./2026-10-16-stealth-cursor-override-specificity.md)、[原生窗口生命周期与共享策略注册](../architecture/2026-10-14-window-surface-lifecycle.md)。

## 根因

`0ae8915` 将多显示器 overlay 合并为单个联合边界窗口时，同时删除了 `#hint` 元素和拖拽后的隐藏逻辑；该提交主题是“截图期间保持焦点”，提示删除没有决策记录。隐身模式下 `html.stealth * { cursor: default }` 是刻意的防暴露约束，因此 overlay 内没有提示后，用户没有任何可发现入口。

## 决定

- 恢复 overlay 内的“按住拖拽选择区域，按 Esc 取消”提示，放在光标所在显示器的顶部中央。
- 拖拽开始后隐藏提示；误触（小于 `MIN_SIZE`）取消选区后重新显示，避免一次误点后永远失去提示。
- 提示留在 selection overlay 内部，不新建窗口、不使用原生 tooltip。隐身时 overlay 仍由 `windowSurfaceRegistry` 应用 `setContentProtection(true)`；保护失败按 `failClosed` 隐藏整个 overlay，因此提示不会单独进入共享画面。
- 不改光标：隐身模式继续使用默认箭头，普通模式继续使用十字光标。

## 修复

- `selection.html`：恢复 `#hint` 与样式（`pointer-events: none`）；接收 `cursorX` / `cursorY`，按光标所在显示器定位提示；`draw` 时隐藏，误触时恢复。
- `selectionWindow.ts`：创建 overlay 时把 `screen.getCursorScreenPoint()` 写入 `cursorX` / `cursorY` 查询参数。
- `selectionWindow.test.ts`：覆盖光标位置参数、隐身 overlay 的捕获保护，以及 `#hint` 静态守卫。

## 曾考虑的替代方案

- **隐身模式恢复十字光标作为提示：** 舍弃。光标形状变化本身会暴露“正在选择”，违反隐身模式的指针约束。
- **给整个屏幕加暗色蒙层或高亮边框：** 舍弃。虽然 overlay 受捕获保护，但大面积视觉变化会破坏本地“零干扰”体验，也与变色龙理念冲突。
- **只在主窗口显示 toast：** 舍弃。截图期间主窗口可能隐藏或处于非激活状态，提示与选区分离，用户仍可能看不到。
- **使用原生 tooltip / `title`：** 舍弃。原生提示由系统/Chromium 合成，无法可靠门控隐身状态，已有 Note 记录其破隐风险。

## 后果与防回退

- 提示必须留在 selection overlay 内，并依赖隐身捕获保护；不得改成独立 BrowserWindow 或原生 tooltip。
- 多显示器下必须按光标位置定位；联合边界窗口的 `top: 16px; left: 50%` 可能落在屏幕缝隙或另一块屏幕。
- 隐身光标保持默认箭头；不要为了可发现性恢复十字光标。
- 误触取消选区后必须恢复提示，不能退回“静默取消”。

## 验证

- `apps/desktop/test/selectionWindow.test.ts`：7 项通过，覆盖隐身 overlay 捕获保护、光标位置参数与提示静态守卫。
- `pnpm exec biome check apps/desktop/src/main/capture/selectionWindow.ts apps/desktop/src/main/capture/selection.html apps/desktop/test/selectionWindow.test.ts` 通过。
- 实机待验证：隐身开启后点击截图，提示出现在光标所在显示器顶部；拖拽出现虚线框；会议共享画面中不出现 overlay 或提示。
