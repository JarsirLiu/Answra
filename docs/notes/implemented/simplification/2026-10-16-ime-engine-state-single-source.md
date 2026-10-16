# Note：IME 引擎事实与 target 归属判定收口为单一来源（S4）

状态：已实施

## 问题

S2a 把 renderer 侧的引擎/租约事实收口到 `imeSessionClient` 快照后，仍有两处"同一事实、两个来源"的遗留：

1. **路由用的引擎事实由两个调用点各自拼装**。`resolveImeKeyRoute` 的第二个参数是一个匿名内联类型 `{ inputMode: "ascii" | "chinese"; composing: boolean }`，`useEmbeddedIme.sendKey` 在两处分别构造它：`queuedEditorKey` 分支从传给 `routeLatest` 的 snapshot 取 `engine.inputMode`/`engine.composing`，普通键分支从 `getImeInputMode()`/`getImeComposing()` 两个独立 getter 取。同一份 `snapshot.engine` 被投影成路由输入的规则存在两遍。
2. **target 归属判定存在两遍**。命令式的 `imeSessionClient.getImeOwnedGeneration(targetId)` 判 `owner.targetId === targetId`；`useEmbeddedIme` 又用响应式派生 `ownsLease = session?.owner?.targetId === targetId` 与 `generation`。规则若变（例如考虑 `phase`），两处都要改。
3. **恒等重复的本地派生**。`useEmbeddedIme` 的 `sessionHoldsTarget = ownsLease || session?.owner?.targetId === targetId` 与 `ownsLease` 恒等，是纯重复。
4. **无消费者的 getter**。`imeSessionClient.isImeTargetOwned` 是 S2a 引入的导出，现无任何调用点（`rg` 仅命中定义），属 S4 要清理的迁移遗留。

后果：引擎事实与归属规则各有两个出处，改动时容易只改一处；且无法用单测直接钉住"路由读到的引擎事实与 target 归属"这条契约。

## 涉及范围

- 代码/模块：`packages/ui/src/ime/imeKeyRouter.ts`（命名类型）、`packages/ui/src/ime/imeSessionClient.ts`（selector + 删死代码）、`packages/ui/src/hooks/useEmbeddedIme.ts`（改用 selector、删重复本地）、新增 `packages/ui/test/imeSessionClient.test.ts`。
- 行为：无变化——`resolveImeKeyRoute` 判定逻辑与调用时机逐字保留；getter 取值逐字等价；归属判定语义不变（仍是 `owner.targetId === targetId`，不引入 `phase` 条件）。
- 契约：不改 `packages/shared`、IPC、`ImeTextPolicy`、`ImeState`；`resolveImeKeyRoute` 仍为纯函数，仅把匿名内联参数类型具名为导出的 `ImeEngineState`。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[renderer 侧状态副本收口（S2a）](../architecture/2026-10-16-ime-renderer-single-writer-facts.md)、[文本回落纯函数](2026-10-16-ime-text-fallback-pure-function.md)。

## 决定

1. `imeKeyRouter` 导出 `ImeEngineState { inputMode: ImeInputMode; composing: boolean }`，`resolveImeKeyRoute(event, engine: ImeEngineState, release?)` 以它接收事实。
2. `imeSessionClient` 新增纯 selector：
   - `selectImeEngineState(snapshot)`：唯一把 `snapshot.engine` 投影成路由输入的实现（缺省 `chinese`/`false`）；
   - `selectImeOwnedGeneration(snapshot, targetId)`：唯一 target 归属规则；
   并让 `getImeInputMode`/`getImeComposing`/`getImeOwnedGeneration` 经它们实现（命令式 getter 与响应式派生共用同一规则）。
3. `useEmbeddedIme`：两个 route 调用点都改用 `selectImeEngineState`（一者传 `latest`、一者传 `getLatestImeSessionSnapshot()`）；`generation` 改用 `selectImeOwnedGeneration(session, targetId)`、`ownsLease = generation !== undefined`；删除恒等的 `sessionHoldsTarget`（effect 直接用 `ownsLease`）。
4. 删除死代码 `isImeTargetOwned`。

**明确不做**：不改 `state` 与 `targetEngaged` 的派生语义。二者是 S2a 已确立的"从 single writer 派生"的正确形态，其中 `targetEngaged = 注册 || owned lease` 是有意的防锁死约束（见 [S2a Note](../architecture/2026-10-16-ime-renderer-single-writer-facts.md)），不属"自算副本"。

## 移除内容

- `useEmbeddedIme.sendKey` 两处本地拼装的 `{ inputMode, composing }`（改为 `selectImeEngineState`）。
- `useEmbeddedIme` 的 `sessionHoldsTarget`（与 `ownsLease` 恒等的重复派生）。
- `useEmbeddedIme` 中与 `selectImeOwnedGeneration` 重复的 `ownsLease`/`generation` 判定（改为消费 selector）。
- `imeSessionClient.isImeTargetOwned`（无消费者）。
- `resolveImeKeyRoute` 的匿名内联 `state` 参数类型（改为命名 `ImeEngineState`）。

## 重新引入条件

- `resolveImeKeyRoute` 的引擎事实只允许来自 `selectImeEngineState`；禁止在任何调用点手拼 `{ inputMode, composing }`。
- target 归属只允许定义在 `selectImeOwnedGeneration`；hook 不得再自写 `owner.targetId === targetId`。
- 不得再新增与既有派生恒等的本地（如 `sessionHoldsTarget`）。
- `resolveImeKeyRoute` 必须保持纯函数：不得让它自行从 `imeSessionClient` 读全局快照。

## 曾考虑的替代方案

- **让 `resolveImeKeyRoute` 自读 `imeSessionClient` 快照（"自足"）：** 舍弃。会把路由判定从纯函数变成读全局状态，破坏"无 Electron 可测"（`imeKeyRouter.test.ts` 直接单测该函数），也让 router 反向依赖 client。本 Note 的边界是"事实投影一处、判定仍纯"，与[文本回落纯函数](2026-10-16-ime-text-fallback-pure-function.md)对 router 边界的论证一致。
- **把两个 route 调用点合并成一个（统一在队列执行时判定）：** 舍弃。`queuedEditorKey` 分支必须在执行时读最新 composing 才能区分 Backspace/方向键走引擎还是编辑器，普通键则必须在 keydown 同步决定 `preventDefault`；合并会改变键盘路由时机，属行为变化，需 Windows/macOS 实机证据（S5 阻塞），不能在自动化测试里拍板。
- **把 `state`/`targetEngaged` 的派生移出 hook：** 舍弃。二者已是"从 single writer 派生"的正确形态，移出等于重新引入副本或破坏 `targetEngaged` 的防锁死约束。
- **删掉 `getImeInputMode`/`getImeComposing` 只留 `selectImeEngineState`：** 舍弃（部分）。两者仍服务诊断与 `asciiMode`，删掉会让多处改为 `getImeEngineState().x`；折中为保留旧 getter、内部经 `selectImeEngineState` 实现，保持单一规则。

## 后果与防回退

- 引擎事实投影与 target 归属规则各只有一处实现；命令式 getter 与 React 响应式派生共用同一条规则，rule 变更只需改一处。
- **有意保留**：`resolveImeKeyRoute` 仍是纯函数、仍接收事实参数；router 不读全局状态。
- **有意保留**：`state`/`targetEngaged`（S2a）派生语义不变，`targetEngaged` 仍不得改成只依赖 coordinator 注册。
- 诊断字段语义（`targetRegistered`/`activeElementTarget`/`documentHasFocus`）不变。

## 验证

- 新增 `packages/ui/test/imeSessionClient.test.ts` 3 项：`selectImeEngineState` 缺省与投影、`selectImeOwnedGeneration` 命中/他 target/无 owner、命令式 getter 与发布快照同源。
- `packages/ui/test/imeKeyRouter.test.ts`、`useEmbeddedIme.test.tsx` 全通过（路由与租约行为等价由原断言保证）。
- `pnpm --filter @answra/ui typecheck` 通过；UI 全量测试 192 项通过；`pnpm verify` 全绿。
