# Note：shell 会话测试在并发负载下清理孤儿进程

状态：已实施

## 问题

全量 `pnpm verify` 偶发失败在 `apps/agent/test/core/tool/shell/sessions.test.ts` 的两个常驻会话用例：`rm` 临时工作区报 `EBUSY`，重试 20 秒后仍失败。单独运行该文件 21/21 通过，全量并发（110 个测试文件、`--maxWorkers=4`）时失败，不能当作偶发放过。

## 涉及范围

- `apps/agent/test/core/tool/shell/sessions.test.ts`：只在 `removeWorkspace` 的删除重试路径新增孤儿清理；不改任何用例断言或生产终止逻辑。
- 不涉及 UI、Agent 会话语义、进程 containment 的协议或超时常量。相关 Note：暂无（生产终止策略未改）。

## 决定

1. 清理按「命令行里明确包含该工作区绝对路径的 node.exe」精确定位，只结束这些进程；宿主 vitest worker、其他测试、用户进程都不匹配，不会被误杀。
2. 只在 `rm` 命中可重试错误（EBUSY/EPERM/ENOTEMPTY/EMFILE）后才调用清理，正常路径零额外开销。
3. 非 Windows 平台不做任何事：孤儿 CWD 句柄是 Windows 特有现象。
4. 不改生产 `terminateProcessTree`：Job Object + taskkill 的错误处理属于运行时策略，本轮只解决测试环境的确定性清理。

## 根因

用例通过 PowerShell 启动 `node <workspace>/xxx.mjs` 这类常驻脚本。Windows 的 containment 依赖 PowerShell 引导时把进程放进带 `KILL_ON_JOB_CLOSE` 的 Job Object；分配失败时降级为 `taskkill /pid <root> /t /f`。全量并发下引导脚本的 `Add-Type` 更容易失败或变慢，兜底 `taskkill` 的进程树快照与实际孙进程创建存在竞态：根 PowerShell 先退出，`node` 孙进程被重新挂到别的父进程下并**继承了该工作区作为 CWD**。Windows 只要还有进程把目录当 CWD，`rmdir` 就返回 `EBUSY`；原有 20 秒重试只是在等一个永远不会自己退出的进程，所以必然超时。实测失败后系统中确实残留 2 个引用这些临时目录的 node 进程，根 PowerShell 已不存在。

## 修复

- `removeWorkspace` 每次重试前调用 `killOrphansUsingWorkspace(workspace)`：用 `powershell.exe -Command` 查询 `Win32_Process` 中 `Name='node.exe'` 且命令行包含该工作区路径的进程，逐个 `Stop-Process -Force`。
- PowerShell 路径必须用单引号字面量注入（双引号会把 Windows 反斜杠翻倍导致匹配不到），三条语句靠管道连成一条流水线；`execFile` 的错误被吞掉，清理失败继续走原有重试与最终抛错，不会把清理失败伪装成成功。

## 曾考虑的替代方案

- **把 20 秒重试延长到 60 秒：** 舍弃。孤儿进程不会自行退出，延长时间只让失败更慢。
- **放宽断言/跳过这两个用例：** 舍弃。它们验证的是真实行为（常驻会话无默认超时、abort 能中断启动），跳过等于掩盖缺陷。
- **让用例自己扫描并杀掉所有 node.exe：** 舍弃。会误杀 vitest worker 与其他测试；必须按工作区路径限定。
- **改生产 `terminateProcessTree` 加更激进的击杀：** 舍弃。这属于运行时进程策略变更，需要单独的缺陷复盘与实机验证；本轮全量失败的直接原因在测试清理，不在断言目标行为。

## 后果与防回退

- 这类临时目录删除失败时，清理只按工作区绝对路径匹配进程；不得改成宽泛的进程名匹配。
- 如果将来生产 containment 策略变化导致孤儿更频繁，应另立 Note 修 `terminateProcessTree`，而不是继续加厚测试清理。
- 用例仍必须显式结束常驻会话（`manager.kill()` / abort），测试清理只是兜底；不得反过来依赖清理来替代断言中的终止动作。

## 验证

- 全量 `pnpm verify` 退出码 0。
- `pnpm --filter @answra/agent test`：110 个测试文件全部通过，不再出现 `EBUSY` 失败。
- 单独运行 `sessions.test.ts`：21/21 通过，行为未变。
