# Note：修复 CommonJS 工作区 watcher 加载

状态：已实施

## 问题

桌面启动后恢复工作区根目录时，`@parcel/watcher` 没有加载，终端报告 `createRequire` 收到 `undefined` 文件名。服务捕获 watcher 初始化异常后继续运行，导致文件变更订阅静默失效。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/workspace/workspaceService.ts`、`apps/desktop/scripts/build-electron.mjs`
- UI/进程/协议/持久化表面：Electron main 的 CommonJS bundle 和工作区文件 watcher

## 根因

Electron main 用 esbuild 输出 CommonJS，而 watcher 工厂以 `createRequire(import.meta.url)` 推导模块路径。esbuild 在 CJS bundle 中将 `import.meta` 清空，运行时传给 `createRequire` 的值为 `undefined`。

## 决定

- 在打包后的 Electron main 中用 CommonJS 全局 `__filename` 创建 require，使依赖从实际 bundle 位置解析。
- 在源码测试环境没有 `__filename` 时，以当前工作目录下的虚拟 CJS 文件路径回退，保持 Node 模块解析行为及现有依赖注入测试。
- 保留 watcher 加载失败日志，避免将此类错误隐藏为成功启动。

## 修复

移除对 `import.meta.url` 的运行时依赖。CJS 产物使用 bundle 文件路径；测试源码路径使用绝对的 CJS 兼容路径作为 `createRequire` 基准。

## 影响表面

工作区根目录恢复、watcher 启动和文件变化事件转发。

## 曾考虑的替代方案

- **把 Electron main 改为 ESM 输出：** 需要同时调整应用入口、外部依赖和打包结构；单个 watcher 加载点无需扩大构建系统变更，舍弃。
- **直接静态导入 `@parcel/watcher`：** 会让单元测试加载平台原生二进制，破坏现有通过注入 watcher 工厂隔离平台依赖的测试方式，舍弃。

## 验收标准

- 可观察结果：CJS 桌面 bundle 中不再通过 `import.meta.url` 初始化 watcher require。
- 自动化验证：桌面 main typecheck、`pnpm --filter @answra/desktop build` 和完整 `pnpm verify` 通过。
- 需要的实机验证：Windows 桌面启动并恢复有效工作区后，不再出现 `ERR_INVALID_ARG_VALUE`，文件变更可触发刷新。

## 后果与防回退

Electron main 输出格式保持 CJS 时，运行时 require 的基准必须来自 CJS 文件路径；不得从 `import.meta.url` 推导。实机 watcher 行为仍需在 Windows 桌面启动时确认。

## 验证

`pnpm --filter @answra/desktop build` 成功，且 esbuild 不再报告 `import.meta` 在 CJS 输出中被清空；`pnpm --filter @answra/desktop test -- workspaceService.test.ts` 通过。Windows 桌面实机启动和文件变更行为待确认。

## 后续

`@parcel/watcher` 最终被移除，`workspaceService.ts` 不再通过 `createRequire` 加载任何原生 watcher，相关 `import.meta.url`/`__filename` 推导逻辑随之删除；监控改用 Node 内置 `fs.watch`（见功能 note）。本 note 的 CJS require 修复随之作废。
