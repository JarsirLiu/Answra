# Note：工作区文件监听启动失败

状态：已实施

## 问题

桌面端启动日志报错 `[workspace] watcher 启动失败 TypeError: watch is not a function`，工作区文件变更监听未建立，外部文件变动不会刷新预览。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/workspace/workspaceService.ts`
- UI/进程/协议/持久化表面：工作区文件监听（主进程）

## 根因

`parcelWatchFactory` 调用了 `@parcel/watcher` 的 `watch()`，但项目依赖的是 `^2.6.0`（v2 API）。v2 已将递归监听函数更名为 `subscribe()`，且返回 `Promise<AsyncSubscription>`；`watch` 在 v2 中不存在，故 `require("@parcel/watcher").watch` 为 `undefined`，调用即 `TypeError: watch is not a function`。

## 决定

改用 v2 的 `subscribe()` 并 `await` 其返回的订阅 Promise；`unsubscribe` 仍返回 `Promise<void>`，工厂签名与测试注入实现不变。不降级 `@parcel/watcher` 版本（v2 是目标平台稳定版）。

## 修复

`parcelWatchFactory` 改为 `async`（箭头函数前加 `async`），使用 `const { subscribe } = require("@parcel/watcher")`，以 `const subscription = await subscribe(dir, callback)` 取得订阅，并在 `unsubscribe` 中转发 `subscription.unsubscribe()`。

## 影响表面

工作区文件监听启动。

## 验收标准

- 可观察结果：启动日志不再出现 `[workspace] watcher 启动失败`，工作区根目录文件变更经 `onWorkspaceChanged` 转发。
- 自动化验证：现有 `WorkspaceService` 测试使用注入的 watch 工厂，不受原生 API 形态影响；`pnpm --filter @answra/desktop typecheck` 与 `pnpm lint` 通过。

## 后果与防回退

`apps/desktop` 主进程对 `@parcel/watcher` 的调用必须使用 v2 的 `subscribe()`（返回 Promise），禁止改用 v1 的 `watch()` 或假定其同步返回订阅对象。

## 曾考虑的替代方案

- **降级到 `@parcel/watcher` v1 以恢复 `watch()` API：** v1 与 v2 的事件语义、订阅生命周期不同，且降级会引入与 Electron/Node ABI 组合未经验证的旧版本；v2 的 `subscribe()` 只是函数更名，修复成本更低，故舍弃降级。
- **换用 `chokidar` 等纯 JS 监听库：** 引入新依赖只为绕过一个函数更名，收益不成比例，且当时已锁定 `@parcel/watcher` 的原生性能优势；故舍弃，保留 v2 API 适配。

## 验证

`pnpm --filter @answra/desktop typecheck`、`pnpm lint` 均通过。

## 后续

`@parcel/watcher` 在 Electron 29 下仍暴露原生二进制加载（含本 note 的 `watch is not a function` 与另一 note 的 `createRequire`/`import.meta.url` 问题），最终决定弃用该依赖，改用 Node 内置 `fs.watch` 做递归监听（见功能 note）。本 note 的 `subscribe()` 修复随之作废。
