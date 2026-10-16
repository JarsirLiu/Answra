# Note：IME 协议面跨模块契约测试

状态：已实施

## 问题

S1–S3 的判据散落在行为测试与代码约定里，但**协议面本身的形状没有被任何测试冻结**：

1. `ImeChannels` 的成员集合与线上字符串（`answra:ime:*`）没有任何断言。改名或加回一个领域 channel，`typecheck` 不会报错（没有消费者时），只有实机运行时才会发现 main/renderer 版本不匹配。
2. preload 暴露的 IME 方法集合没有断言。[IME IPC 表层收敛为单一入口](../simplification/2026-10-16-ime-ipc-surface-single-entry.md) 删除了 `imeAcquire`/`imeKey`/…，但没有任何测试阻止它们被重新加回。
3. `ImeSessionCommandResult` 的信封纪律（`snapshot` 恒在、`reason` 仅出现在 `accepted === false`、`commit` 仅在引擎产出文本时出现、`engineHandled` 仅 `processKey`）没有统一断言，只有零散用例间接覆盖。
4. `imeSessionClient` 的 revision 单调拦截（忽略倒退快照）没有用例。
5. 两个租约释放原因 `renderer-process-gone` / `window-navigation` 在 `imeIpc.ts` 里有实现，但没有任何用例触发。

关键陷阱：`apps/desktop` 的 `tsc` 项目（`tsconfig.main.json`/`preload.json`/`renderer.json`）都**不包含 `test/`**，`vitest` 只做转译不做类型检查。因此**类型层面的契约断言（`expectTypeOf`）在本仓库是失效的**——它既不会被 `typecheck` 检查，运行时也被擦除。契约锁必须是运行时断言。

## 涉及范围

- 代码/模块：无生产代码改动。新增 `apps/desktop/test/imeProtocolContract.test.ts`（契约锁）；`apps/desktop/test/imeIpc.test.ts` 追加信封与释放原因用例；`packages/ui/test/imeSessionClient.test.ts` 追加 revision 用例。
- UI/进程/协议/持久化表面：冻结 `ImeChannels` 集合与线上字符串、preload IME 方法集合、`ImeSessionCommandResult` 信封、client revision 单调、两个租约释放原因。
- 相关 Note：[表层收敛](../simplification/2026-10-16-ime-ipc-surface-single-entry.md)、[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

本切片只补"契约形状"测试（S4 的另一半），不改任何生产行为：

1. `imeProtocolContract.test.ts`：断言 `ImeChannels` 精确等于三条 `answra:ime:*`；`vi.mock("electron")` 后 import 真正的 preload，捕获 `contextBridge.exposeInMainWorld("answra", …)` 的参数，断言全局名、`ime*` 方法集合精确为 `imeAvailable`/`imeDiagnostic`/`imeSessionCommand`、无 `ime(Acquire|Release|ConfirmFocus|Key|Select|Reset|Change)`、`getImeSessionSnapshot`/`onImeSessionSnapshot` 仍在、`imeSessionCommand` 经 `SessionCommand` 频道发送。
2. `imeIpc.test.ts`：新增"accepted 无 `reason` 且恒有 `snapshot`"、"`commit` 仅在产出文本时出现、`engineHandled` 仅 `processKey`"、"`renderer-process-gone` 释放原因"、"`window-navigation` 释放原因"四个用例。
3. `imeSessionClient.test.ts`：新增忽略 revision 倒退快照的用例。

## 测试范围

- 锁**形状**而非行为：频道集合/字符串、preload 暴露面、结果信封字段纪律、client revision 单调、两个冻结的释放原因字符串。
- **不**覆盖（有意留给行为测试或 S5 实机）：键路由与 DOM 命中、composition 投影、候选窗几何裁剪、原生 IME 隔离时序。
- 覆盖缺口已记录：`apps/desktop/test` 不在任何 `tsc` 项目中，故桌面端测试文件本身无类型检查；本次因此全部使用运行时断言。若要恢复类型级契约锁，需先把 `test/` 纳入一个 `tsc` 项目（独立改动）。

## 曾考虑的替代方案

- **用 `expectTypeOf` 做类型级契约锁：** 舍弃。`apps/desktop/test` 不在任何 `tsc` 项目中，`vitest` 只转译，`expectTypeOf` 永远不会被检查。经负向验证确认：给 `DesktopBridge` 加回 `imeKey` 后 `pnpm --filter @answra/desktop typecheck` 仍 exit 0。故改为 import 真实 preload 捕获 `exposeInMainWorld` 载荷的运行时断言。
- **把契约测试放进 `packages/shared`：** 舍弃。`packages/shared` 没有 vitest 脚本与配置，为一个断言引入整套测试基建不划算；`apps/desktop/test` 已可直接 import `@answra/shared` 源码出口。
- **断言 preload 的完整键集：** 舍弃。任何非 IME 的新增 bridge 方法都会误伤该断言；只锁 IME 相关子集（业务上真正会被 S1–S4 回归的面）。
- **用仓库既有的 `imeIpc.test.ts` harness 覆盖 preload：** 舍弃。该文件测的是 main 侧，不 import preload、不 mock `electron`；把 preload 塞进去会混入两种进程环境，独立文件更清晰。

## 后果与防回退

- 任何重新加回 `ime<动作>` 独立方法、改频道字符串、让 `reason` 出现在 accepted 结果里、或让快照 revision 倒退，都会立刻有测试失败；负向验证（临时加回 `imeKey`）已确认锁有效。
- 有意接受的代价：preload 测试 mock 了 `electron` 并依赖 import 副作用（模块顶层 `exposeInMainWorld`）；若 preload 改为惰性暴露需同步调整该测试。
- 记录一条通用约束：**本仓库桌面端测试文件没有类型检查**，不要用类型断言充当门禁。

## 验证

- `apps/desktop/test/imeProtocolContract.test.ts`(3) 与追加后的 `imeIpc.test.ts`(28) 通过；负向验证：临时加回 `imeKey` 后该文件 1 failed。
- `packages/ui/test/imeSessionClient.test.ts`(4) 通过。
- `pnpm typecheck`、`pnpm test`、`pnpm verify` 全绿。
