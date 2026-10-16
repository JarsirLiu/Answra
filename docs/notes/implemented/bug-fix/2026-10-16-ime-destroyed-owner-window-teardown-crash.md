# Note：窗口销毁后 detach 租约监听器导致主进程崩溃

状态：已实施

## 问题

在对话面板里发过消息（内置输入法持有租约）后关闭应用，主进程弹出未捕获异常对话框：

```
TypeError: Object has been destroyed
  at detachLeaseListeners
  at releaseOwnedLease    ← BrowserWindow 的 closed 事件
  at Object.dispose       ← 应用退出时 registerImeIpc().dispose()
```

两条堆栈都在 `detachLeaseListeners()`：一条来自 owner 窗口的 `closed` 事件，一条来自应用退出时的 `dispose()`。用户必须先点掉弹窗才能关掉应用。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeIpc.ts`、`apps/desktop/test/imeIpc.test.ts`。
- UI/进程/协议/持久化表面：仅 main 进程租约监听器的挂载/卸载与 `findWindow` 查找；不改 IPC 协议、renderer 或 Rime 行为。
- 相关 Note：[IME 租约释放原因与默认焦点链日志](./2026-10-16-ime-release-cause-diagnostics.md)、[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)、[IME 输入目标 blur 与窗口失焦顺序](./2026-10-16-ime-lease-blur-focus-handoff.md)。

## 根因

`attachLeaseListeners` 注册的四个 detach 闭包里有两个直接读取 `window.webContents`：

```ts
() => window.webContents.removeListener("render-process-gone", onGone),
() => window.webContents.removeListener("did-start-navigation", onNavigation),
```

BrowserWindow 被销毁后读取 `.webContents` 会抛 `TypeError: Object has been destroyed`。而 detach 恰恰只在这些时刻发生：

1. owner 窗口 `closed` → `releaseOwnedLease("owner-window-closed")` → `detachLeaseListeners()`（此时窗口已销毁）；
2. 应用退出 → `dispose()` → `detachLeaseListeners()`（窗口可能已销毁）；
3. `render-process-gone`、主框架导航、以及 acquire 换 owner 时（此时窗口仍存活）。

也就是说，"窗口已经销毁" 是这条路径的**正常输入**，但代码把 `webContents` 当成随取随用的属性。`publishSnapshot`、`suspendCurrent` 等相邻代码都有 `isDestroyed()` 守卫，只有这里没有。

该缺陷与 2026-10-16 的诊断日志改动无关：`git diff` 可确认 `detachLeaseListeners()` 调用位置与两个闭包在 S1 提交中未改动，属于既有缺陷；此前"持有租约时关闭窗口"这条路径缺少默认可见的日志，也没有被反复走通，因此在这次真实使用中才被稳定复现。

## 决定

租约监听器的卸载必须能在 owner 窗口已销毁的情况下完成：attach 时捕获 webContents 引用，卸载前检查 `isDestroyed()`；窗口查找只返回存活窗口。teardown 路径不再把 `window.webContents` 当作随取随用的属性。

## 修复

- `attachLeaseListeners` 在挂载时捕获 `const contents = window.webContents`，注册与卸载都使用该引用；两个 webContents 卸载闭包在 `contents.isDestroyed()` 为真时跳过卸载，避免访问已销毁对象。
- `findWindow(id)` 现在跳过 `isDestroyed()` 的窗口：调用方只把它用于"给仍然活着的窗口发消息/清候选"，返回已销毁窗口没有意义。
- 回归测试：`imeIpc.test.ts` 新增两项，用 `Object.defineProperty` 让 `window.webContents` 在"销毁后"读取即抛（同时让 `contents.isDestroyed()` 返回 true），断言 `closed` 事件与 `dispose()` 都不再抛异常，且 `lease-released` 仍以 `owner-window-closed` 记录。

## 曾考虑的替代方案

- **在 `detachLeaseListeners` 外面包 `try/catch` 忽略异常：** 舍弃。它会把"窗口已销毁"和真正的监听器泄漏/逻辑错误一起吞掉，也无法解释为什么 detach 要在销毁后运行；按 `isDestroyed()` 明确分支才能保留可判定性。
- **在 `releaseOwnedLease` 里提前 return，不做 detach：** 舍弃。窗口销毁后监听器仍留在 `leaseListeners` 数组里，下一次 acquire 挂新租约会重复注册，且 `dispose()` 仍会遍历到旧闭包。
- **卸载闭包里改成 `BrowserWindow.fromId(id)` 重新查找窗口：** 舍弃。多一次查找且仍然要判断销毁状态，不解决"读取属性即抛"的问题；持有挂载时的引用更直接。
- **让 `closed`/`dispose` 不再调用 `detachLeaseListeners`：** 舍弃。`closed` 是租约转移的正常路径，必须清掉旧监听器与 blur 定时器。

## 后果与防回退

- teardown 路径（`closed`、`render-process-gone`、主框架导航、`dispose`、acquire 换 owner）必须假设 owner 窗口或 webContents 可能已经销毁：禁止在 detach 闭包里重新读取 `window.webContents`，必须使用挂载时捕获的引用并检查 `isDestroyed()`。
- `findWindow` 只返回存活窗口；需要向已销毁窗口发送消息的调用方应自己处理"找不到"的分支。
- 崩溃只影响 main 进程的错误对话框，不会写日志文件；这类"teardown 时对象已销毁"的问题今后按同一模式修复，不要退回 try/catch。

## 验证

- 自动化：`pnpm --filter @answra/desktop test` 26 个文件 / 147 项通过（新增 2 项）；`pnpm verify` 通过（Biome、Note 门禁、全包 typecheck、UI/desktop/app 测试、architecture check）。
- 需要用户实机验证：发消息后直接关闭应用、关面板后关闭应用、输入法组字中关闭窗口，确认不再出现 "A JavaScript error occurred in the main process"。
