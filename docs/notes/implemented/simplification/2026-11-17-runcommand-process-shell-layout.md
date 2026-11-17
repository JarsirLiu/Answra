# Note：RunCommand 进程与 shell 模块纯拆分

状态：已实施

## 问题

`runCommand` 的 `process/` 同时承担 shell 调用、输出解码、工作目录和跨平台终止，`processTree.ts` 一个文件混有 POSIX 与 Windows 实现。一次性命令和可续接会话已经共用 `spawnShellProcess`，但 `spawn.ts` 仍在判断平台，进程后端也不能独立测试。继续往 `sessions.ts` 或 `processTree.ts` 加逻辑，会让后续统一执行路径更难安全迁移。

## 涉及范围

- `apps/agent/src/core/tool/builtin/runCommand/shell/output.ts`
- `apps/agent/src/core/tool/builtin/runCommand/shell/workdir.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/containment.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/windows.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/posix.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/delay.ts`
- `apps/agent/src/core/tool/builtin/runCommand/process/spawn.ts`
- 相关测试与 `docs/notes/proposed/architecture/2026-11-17-runcommand-unified-exec-lifecycle.md`

## 决定

- `shell/output.ts` 接管输出解码、截断、PowerShell 错误清理和输出缓冲上限；`shell/runtime.ts` 只保留 shell 选择与调用构造。
- `shell/workdir.ts` 从 `process/` 移入 `shell/`；工作目录是 shell 事实，不是进程 containment。
- `process/windows.ts` 接管 Job Object bootstrap、marker、`taskkill` 兜底和 Windows 终止；`process/posix.ts` 接管进程组 `SIGTERM → 探活 → SIGKILL`。
- `process/containment.ts` 是唯一平台工厂，`spawn.ts` 只组装 invocation 与 spawn 参数，不再出现 `process.platform`。
- `processTree.ts` 删除；`terminateProcessTree` 兼容入口暂时保留在 `containment.ts`，供未迁移的 `oneShot`/`sessions` 使用。
- 本阶段不改一次性命令与会话的任何可观察行为；`oneShot.ts`、`sessions.ts`、`tool.ts` 的公开契约不变。

## 曾考虑的替代方案

- **继续保留 `processTree.ts`，只抽 `shell/output.ts`**：舍弃。平台终止仍与 shell 输出混在一个文件，`spawn.ts` 也要继续判断平台。
- **一次性删除 `oneShot`/`sessions`，直接建统一 manager**：舍弃。行为矩阵尚未固化为测试，风险不可控；先做纯拆分，再按 one-shot、session 顺序迁移。
- **把 `delay` 重复进 `windows.ts`/`posix.ts`**：舍弃。两个后端共用的异步原语单独放 `process/delay.ts`，避免复制。
- **将 `workdir` 留在 `process/`**：舍弃。它只解析 shell 的 cwd，不创建或终止进程，放在 `shell/` 更符合依赖方向。

## 移除内容

- 删除 `process/processTree.ts`，其 Windows 与 POSIX 职责分别移入 `process/windows.ts`、`process/posix.ts`。
- `shell/runtime.ts` 移除输出解码、截断、PowerShell 错误清理和 `SHELL_OUTPUT_BUFFER_BYTES`，改由 `shell/output.ts` 提供。
- `process/workdir.ts` 不再保留，工作目录解析移入 `shell/workdir.ts`。
- `spawn.ts` 移除 `process.platform` 判断、marker 路径生成和 `env` 组装，改由 `createProcessContainment()` 返回。

## 重新引入条件

- 只有出现第二个非 shell 的进程调用方，且 `containment.ts` 的接口无法覆盖时，才考虑新增独立进程后端；不得把平台分支重新放回 `spawn.ts`。
- 只有输出缓冲出现可复现的内存压力时，才引入 head-tail 或流式落盘；不能以“统一路径”为理由提前改变现有输出上限语义。
- 只有统一 `command.ts` 落地并通过行为矩阵测试后，才删除 `terminateProcessTree` 兼容入口。

## 后果与防回退

- `spawn.ts` 不得重新出现 `process.platform`；平台分支只能落在 `containment.ts` 及 `windows.ts`/`posix.ts`。
- `shell/runtime.ts` 不得重新吸收输出解码、截断或 PowerShell 错误清理。
- `process/windows.ts` 的 Job Object marker 和 `taskkill` 降级语义必须保留；不能把 assign 失败伪装成成功。
- `terminateProcessTree` 兼容入口是迁移期临时 API，阶段 2/3 完成后应由 command 持有 handle 并删除。
- 测试目录暂不整体迁移；现有 `test/core/tool/shell/` 继续作为行为基线。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- 本次改动文件 Biome check：通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell`：9 个文件、84 项通过。
- 新增 `containment.test.ts` 覆盖 Windows Job Object 与 POSIX 进程组工厂选择；Windows `spawn.test.ts` 仍只断言 marker 非 `unknown`，POSIX 终止测试在 Windows 跳过。
- `pnpm notes:check`：通过。
- `pnpm verify`：未通过，但失败不在本变更范围。Biome 921 文件通过；各包 typecheck 通过；agent 84 个文件/620 项通过，UI 47 个文件/328 项通过，desktop 53 个文件/350 项通过。CLI 在 `test/tui/commands/configPanel.test.tsx` 有 4 项失败（318 项中 314 项通过），来自当前工作区并行的未提交 TUI 改动；这些文件未修改、未纳入本提交。
