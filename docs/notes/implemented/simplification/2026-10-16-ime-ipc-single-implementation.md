# Note：IME main IPC 双入口合并为单一实现（S4）

状态：已实施

## 问题

`apps/desktop/src/main/ime/imeIpc.ts` 同时保留两套入口：领域 channel（`Acquire`/`Release`/`Key`/`Select`/`Reset`/`ConfirmFocus`）与注解为迁移目标的 `SessionCommand`。`SessionCommand` 并不直接执行逻辑，而是通过 `invokeLegacyHandler` **回调重新调用已注册的领域 IPC handler**，借此复用其校验与 revision 检查。

这套往返带来三类耦合：

1. **全局可变状态**：`invokeHandlers`（channel → listener）让 `SessionCommand` 依赖"哪些 IPC handler 已经注册"，注册顺序或拼写错误只在运行时暴露。
2. **按 `event` 传递 revision**：`expectedRevisionByEvent`（`WeakMap<IpcMainInvokeEvent, number>`）把 revision 检查藏在一次伪造的 invoke 里，`serialize(event, …)` 又从 WeakMap 取回，执行路径需读三段代码才能拼出"这次用了哪个 revision"。
3. **双实现分叉风险**：任何只在其中一套入口改动的逻辑都会让两入口行为分叉；`{ staleRevision: true }` 哨兵值还要在 `serialize`、`invokeLegacyHandler`、外层检查之间来回搬运。

`SessionCommand` 是 renderer 的唯一生产入口（生产 renderer 只用 `imeSessionCommand`/`imeDiagnostic`），领域 channel 已无生产消费者，此往返只服务旧迁移路径。

## 涉及范围

- 代码/模块：仅 `apps/desktop/src/main/ime/imeIpc.ts`；测试沿用 `apps/desktop/test/imeIpc.test.ts`（24 项）。
- UI/进程/协议/持久化表面：不新增/删除 IPC 频道，不改 `packages/shared` ChannelMap/bridge、不改 `preload`、不改 renderer 与候选窗；外部可观察行为不变。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[候选窗事实域拆分（S3）](../architecture/2026-10-16-ime-candidate-window-single-writers.md)。

## 决定

两套入口共用同一组实现函数，`SessionCommand` 不再回调 IPC handler：

1. 从领域 handler 抽出 `performAcquire`/`performRelease`/`performConfirmFocus`/`performKey`/`performSelect`/`performReset`，签名为 `(event, request, expectedRevision?) => …`；领域 channel 注册变成一行薄包装 `handle(ImeChannels.X, (event, request) => performX(event, request))`。
2. `serialize(operation, expectedRevision?)` 直接用入参判断 revision，不一致即 `throw new StaleImeRevisionError()`；删除 `expectedRevisionByEvent`。
3. `SessionCommand` 直接 `await performX(...)`，`suspend`/`resume` 的 stale 也改为抛错；整个分派包一层 `try/catch`，把 `StaleImeRevisionError` 统一映射为 `rejectedSessionCommand(…, "stale-revision", …)`。
4. 删除 `invokeLegacyHandler`、`invokeHandlers` 与 `{ staleRevision: true }` 哨兵及其外层检查；`invalid-transition` 哨兵保留（`resume` 的独立语义）。

## 移除内容

- `invokeLegacyHandler(channel, …)` 回调函数。
- `invokeHandlers`（`Map<string, listener>`）与注册时的 `invokeHandlers.set(...)`。
- `expectedRevisionByEvent`（`WeakMap<IpcMainInvokeEvent, number>`）。
- `serialize(event, …)` 的 `event` 形参，以及 `{ staleRevision: true }` 返回值与其外层判定分支。

## 重新引入条件

- 若将来新增第三种入口，必须直接调用同一组 `performX`，禁止再通过 IPC handler 回调复用逻辑。
- 禁止重新引入"按 `IpcMainInvokeEvent` 传递 revision"的 WeakMap；revision 只能作为函数入参流动。

## 模块边界

- `imeIpc.ts` 内部：`performX` 是每个领域操作的唯一实现；`serialize` 是唯一的串行化 + revision 校验点；`handle(...)` 只做 IPC 注册与快照发布，不含业务。
- 领域 channel 与 `SessionCommand` 只是同一实现的两种调用形态，不得各自新增分支。

## 曾考虑的替代方案

- **彻底删除领域 channel 与 `preload`/`bridge` 方法（`imeAcquire` 等）：** 本次**分期**而非舍弃。生产 renderer 已无消费者，但 `apps/desktop/test/imeIpc.test.ts` 用它们直接驱动 main（30+ 调用点），`packages/ui/test/*` 用它们做 bridge shim；一次性删除需要重写大量测试 mock 与断言，会把这个低风险结构合并变成难以审阅的测试迁移。先合并实现，删除表层作为后续独立改动。
- **保留 `invokeLegacyHandler` 回调，只补测试：** 舍弃。它保留"依赖已注册 handler 的全局状态 + 伪造 invoke + WeakMap 传 revision"三处耦合，是双入口分叉的根源。
- **只给领域 channel 加 deprecated 注释：** 舍弃。不改结构，两套入口仍可能各自演化。

## 后果与防回退

- 两入口现共用唯一实现；领域 channel 的 `expectedRevision` 恒为 `undefined`（与合并前一致），`SessionCommand` 才传 revision。
- 新增领域操作时，必须只写一个 `performX`，两处入口都调用它；不得为某一入口加特例分支。
- 有意接受的代价（2026-10-16 已消除）：当时 `preload` 仍暴露 `imeAcquire` 等 6 个方法、`shared/bridge.ts` 仍声明它们，因此**IPC 表面仍是双入口**——本 Note 只声明"实现已合并"，不声称表层已删除。后续已在[IME IPC 表层收敛为单一入口](./2026-10-16-ime-ipc-surface-single-entry.md) 中删除领域 channel 与 `preload`/`bridge` 方法。

## 验证

- `apps/desktop/test/imeIpc.test.ts` 24 项全部通过（未改动测试，行为等价性由原断言保证）。
- `pnpm verify` 全绿（Biome、Note 门禁、全包 typecheck、UI 168、desktop 150、app 7、architecture check）。
