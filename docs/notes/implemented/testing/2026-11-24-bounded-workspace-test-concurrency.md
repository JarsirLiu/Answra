# Note：限制全量测试的并发峰值

状态：已实施

## 问题

根目录 `pnpm test` 通过 pnpm recursive 同时运行多个 workspace 的测试；每个 Vitest 又按机器资源并行执行测试文件。两层并发叠加会产生较高 CPU 峰值，桌面风扇明显加速。UI 包采用 jsdom，文件级环境启动也增加资源消耗。

## 涉及范围

- 工程入口：根 `package.json` 的 `test` 脚本；`pnpm verify` 复用该脚本，因此一并受控。
- 测试工具：各包统一使用 Vitest，接受根脚本传入的 `--maxWorkers=4`。
- 文档：会话架构决策速查更新资源并发约束。
- 产品行为、测试断言与生产代码：无变化。

## 测试范围

本变更只验证根测试编排参数能限制 workspace 与 Vitest worker 的并行度，并确认完整测试矩阵仍可通过；不改变单测隔离语义、断言或覆盖率门槛。

## 决定

- pnpm workspace 测试最多并行执行 2 个（`--workspace-concurrency=2`）。
- 每个包的 Vitest 最多使用 4 个 worker（`--maxWorkers=4`）。
- 单包定向测试保持原有包级脚本；需要更低负载时可以单独传 `--maxWorkers=1`。

全量测试的总耗时可能增加，换取峰值并发可预测、避免多包与多 worker 同时争抢 CPU。先采用统一上限，不在各包重复维护不同资源策略。

## 曾考虑的替代方案

- **只降低 Vitest worker 数**：workspace 仍会同时启动多个 Vitest 实例，整体 CPU 峰值仍会叠加，因此不足以解决双层并发。
- **只串行 workspace**：单个大型包仍会按 14 线程机器默认并行大量测试文件，仍可能带来高负载。
- **关闭隔离或改用共享线程池**：有机会减少 jsdom 环境初始化开销，但会改变测试文件隔离语义；在缺少隔离安全证据前不采用。
- **继续保持默认并行**：总耗时可能更短，但与用户观察到的持续高风扇负载不符。

## 后果与防回退

- 根 `pnpm test` 与 `pnpm verify` 的测试阶段最多并行跑两个 workspace，每个 Vitest 最多四个 worker；总体 Vitest worker 上限为 8。
- 新增 workspace 测试包后自动继承此限制，无须复制配置。
- 若后续调高并发，需先记录真实机器上的 CPU/耗时对比，不能同时放开 workspace 与 Vitest 两层并发。

## 验证

- `pnpm --filter @answra/shared test --maxWorkers=1`：5 个测试文件、64 项通过；证明 pnpm 可将 worker 上限参数传递给 Vitest。
- 初次全量验证使用 workspace 串行、每包 2 workers：Agent 825 项（72 秒）、UI 358 项（63 秒）通过，但整轮运行 8 分钟仍未完成，已中断。改为 workspace 并发 2、每包 3 workers 后，CLI 一项 Ink 面板测试在并行资源竞争下超过 20 秒测试超时（单独运行通过），故每包上限再提高到 4；最终全量验证待本次变更后运行。
