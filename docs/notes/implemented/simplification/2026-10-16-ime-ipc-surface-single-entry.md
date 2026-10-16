# Note：IME IPC 表层收敛为单一入口（S4）

状态：已实施

## 问题

[main IPC 双入口合并](./2026-10-16-ime-ipc-single-implementation.md) 已让 `imeIpc.ts` 的两套入口共用同一组 `performX` 实现，但**表层仍是双入口**：`packages/shared/src/channels.ts` 仍声明领域 channel（`Acquire`/`Release`/`ConfirmFocus`/`Key`/`Select`/`Reset`，以及无消费者的 `Change`）与对应 `ImeChannelMap` 项，`bridge.ts` 的 `DesktopBridge` 仍暴露 `imeAcquire`/`imeRelease`/`imeConfirmFocus`/`imeKey`/`imeSelect`/`imeReset`/`onImeChange`，`apps/desktop/src/preload/index.ts` 仍把它们接到 IPC。

这是三处具体代价，而非风格问题：

1. **契约有两个真相源**：`SessionCommand` 与领域 channel 都描述同一批会话操作，改契约必须同步两处，`ImeChannelMap` 的领域项没有任何运行时消费者。
2. **preload 暴露了 renderer 永远不调的 API**：生产 renderer 只用 `imeSessionCommand`/`imeDiagnostic`/`SessionSnapshot` 与候选面，其余方法只会诱导新代码误用旧路径。
3. **隐患实现残留**：`performConfirmFocus` 只被 `ConfirmFocus` handler 调用，删掉领域 channel 后即成死代码；`Change` channel 在 main 侧无发送方，`onImeChange` 无消费者。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`（`ImeChannels`/`ImeChannelMap`）、`packages/shared/src/bridge.ts`（`DesktopBridge`）、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ime/imeIpc.ts`（删除 handler 注册与死代码 `performConfirmFocus`）。`performAcquire`/`performRelease`/`performKey`/`performSelect`/`performReset` 保留，供 `SessionCommand` 使用。
- UI/进程/协议/持久化表面：删除 IPC 频道常量与 bridge 方法，属**收缩**契约。对外可观察行为不变：renderer 仍只经 `imeSessionCommand` 变更会话，快照仍经 `SessionSnapshot` 推送，诊断仍经 `Diagnostic` 上报。
- 测试：`apps/desktop/test/imeIpc.test.ts` 的领域 channel 调用迁移到 `SessionCommand`；`packages/ui/test/useEmbeddedIme.test.tsx`、`markdownEditorPane.test.tsx`、`ChatPanel.test.tsx` 的测试夹具改为自行声明被删方法的本地类型（仅测试脚手架，不再引用 `DesktopBridge` 的已删成员）。
- 相关 Note：[main IPC 双入口合并](./2026-10-16-ime-ipc-single-implementation.md)、[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

把 IPC 会话面收敛为单一条目，领域 channel 从契约与传输层一并移除：

1. `ImeChannels` 只保留 `Diagnostic`、`SessionCommand`、`SessionSnapshot`；`ImeChannelMap` 只保留这三项。删除 `Acquire`/`Release`/`ConfirmFocus`/`Key`/`Select`/`Reset`/`Change`。
2. `DesktopBridge` 删除 `imeAcquire`/`imeRelease`/`imeConfirmFocus`/`imeKey`/`imeSelect`/`imeReset`/`onImeChange`；保留 `imeAvailable`、`imeDiagnostic`、`imeSessionCommand`、`getImeSessionSnapshot`、`onImeSessionSnapshot` 与候选窗方法。`ImeKeyRequest`/`ImeLeaseResponse` 仍保留在 `shared`（main 内部 `RimeBridge`/`ImeSessionManager` 继续使用，不再是 IPC 载荷）。
3. `preload` 同步删除上述方法，`imeDiagnostic` 与 `SessionCommand` 原样保留。
4. `imeIpc.ts` 删除 `handle(ImeChannels.X, …)` 注册，并删除只服务该入口的死代码 `performConfirmFocus`；`SessionCommand` 继续直调 `performX`。
5. 测试：`imeIpc.test.ts` 新增 `acquire()`/`leaseGeneration()` 辅助函数，全部租约/按键/候选操作改为发 `SessionCommand` 并按 `ImeSessionCommandResult` 的 `snapshot` 断言（`owner.generation`、`engine.*`、`reason`）；UI 三个测试文件把夹具桥声明为本地 `LegacyImeBridge`（`DesktopBridge & { imeAcquire?: … }`），由夹具把旧方法翻译到 `imeSessionCommand`，不再触碰 `DesktopBridge` 的已删成员。

明确不做：不合并 `sendKey` 的两个 route 分支（会改变路由时机，需 S5 实机证据）；不改 `state`/`targetEngaged` 语义；不改候选窗任何面。

## 移除内容

- `ImeChannels.Acquire`/`Release`/`ConfirmFocus`/`Key`/`Select`/`Reset`/`Change` 频道常量及 `ImeChannelMap` 对应项。
- `DesktopBridge.imeAcquire`/`imeRelease`/`imeConfirmFocus`/`imeKey`/`imeSelect`/`imeReset`/`onImeChange`。
- `preload` 中上述 7 个方法的实现（含 `onImeChange` 的 `ipcRenderer.on(ImeChannels.Change, …)` 订阅）。
- `imeIpc.ts` 中 6 条领域 handler 注册与死代码 `performConfirmFocus`（含其 `focus-confirmed` 日志，该事件名从未进入共享诊断事件表，也无任何消费者）。

## 重新引入条件

- 任何新的会话操作都必须是 `ImeSessionCommand` 的联合成员，经 `SessionCommand` 进入 main；禁止新增名为 `ime<动作>` 的独立 domain 方法或平行 channel。
- `DesktopBridge` 的 IME 写入面只允许 `imeSessionCommand` 单一入口；若确需第二入口，必须先在本 Note 记录理由并给出"两入口不会分叉"的测试约束。
- 禁止恢复 `onImeChange` 这类"main 推送整份 `ImeState`"的旁路：状态事实只经 `SessionSnapshot` 推送。

## 曾考虑的替代方案

- **保留领域 channel 作为内部便利 API，只从 preload/bridge 删除：** 舍弃。channel 常量与 `ImeChannelMap` 仍会留在 `shared` 契约里，`SessionCommand` 与领域 channel 仍是两个真相源，且 `performConfirmFocus` 这类死代码会继续存在。要么彻底删，要么别动。
- **保留测试中的 `legacyBridge` 引用 `DesktopBridge` 的已删成员：** 舍弃，因为类型上无法做到——删除 `DesktopBridge` 成员后，测试夹具访问 `bridge.imeAcquire` 会直接编译失败。改为在测试内声明本地 `LegacyImeBridge` 类型，语义上明确"这只是把旧引擎模拟翻译到新入口的脚手架"。
- **一次性删掉 `ImeKeyRequest`/`ImeLeaseResponse`：** 舍弃。它们是 main 内部 `RimeBridge`/`ImeSessionManager` 的真实载荷类型，只是不再是 IPC 契约的一部分；删除会牵连 main 内部接口重命名，收益与本变更目标（收敛 IPC 表层）无关，留作独立改动。
- **保留 `imeIpc.test.ts` 旧断言形状（包装回 `{ accepted, state, generation }`）：** 舍弃。那会在测试里重建一份已被删除的旧契约视图，掩盖真实返回结构；直接按 `ImeSessionCommandResult`（`snapshot`/`engineHandled`/`commit`/`reason`）断言，才能让测试约束与唯一入口对齐。

## 后果与防回退

- IPC 会话面现在只有一个入口 `answra:ime:session-command`；`shared` 不再声明任何无消费者的 IME channel。
- 删除的文件/符号由 `pnpm typecheck` 强制：任何残留的 `imeKey`/`imeAcquire` 等引用都会编译失败，防止表层悄悄长回来。
- 有意接受的代价：`imeIpc.test.ts` 的租约断言从"读顶层 `generation`"改为"读 `snapshot.owner.generation`"，命中非所有者/过期命令时断言 `reason: "stale-owner"`（旧领域入口返回的是 `{...EMPTY_STATE}`，语义等价但形状不同）。
- 有意接受的代价：UI 测试夹具仍以旧方法名组织引擎行为（翻译层在测试内），未改为直接实现 `imeSessionCommand` 语义；这属于测试脚手架债，不影响生产契约。

## 验证

- `apps/desktop/test/imeIpc.test.ts` 24 项全部通过（全部迁移到 `SessionCommand` 后行为等价）。
- `packages/ui/test/useEmbeddedIme.test.tsx`(22)、`markdownEditorPane.test.tsx`(7)、`ChatPanel.test.tsx`(2) 全绿。
- `pnpm verify` 全绿：Biome、Note 门禁、全包 typecheck、UI 192、desktop 150、app 7、architecture check。
