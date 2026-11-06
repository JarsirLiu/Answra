# Run Core

本目录提供跨领域、仅进程内有效的 run 生命周期协调原语。

- `registry.ts`：登记 `runId` 与 `AbortController`，支持取消、等待完成、统计在途数量和进程退出时批量中止。

这里不是 Execution 领域的状态机，也不是持久化 store。重启后恢复和 durable 状态必须由 `apps/agent/src/execution/` 的持久化 adapter 负责；当前 Execution 只提供进程内实现。
