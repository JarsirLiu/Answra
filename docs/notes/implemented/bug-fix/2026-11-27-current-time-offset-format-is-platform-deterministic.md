# Note：当前时间上下文的时区偏移改为显式计算

状态：已实施

## 问题

`apps/agent/test/core/context/currentTime.test.ts` 的 UTC 用例在 Windows 上失败：期望 `... (UTC, UTC+00:00)`，实际得到 `... (UTC, UTC)`。同一份源码在不同平台的 ICU 上给出不同结果，`pnpm verify` 因此在部分机器上恒红。它不是面试双模式改动引入的缺陷，但会让全量门禁失去作为可信质量信号的意义。

## 涉及范围

- 代码：`apps/agent/src/core/context/currentTime.ts` 的 `formatUtcOffset`。只影响注入模型 system reminder 的偏移字符串，不改时间本身、不改事件或协议。
- 测试：`apps/agent/test/core/context/currentTime.test.ts`。保留原有精确断言，新增半小时偏移与本地日期回退到前一天两例。
- 相关 Note：[面试演练与辅助模式](../feature/2026-11-27-interview-rehearsal-and-assist-modes.md)。本修复独立成篇，因为根因与平台相关，不属于面试领域。
- 不新增事件、不改持久化、不改 UI 投影；`buildCurrentTimeContext` / `appendCurrentTimeContext` 的签名与调用方不变。

## 决定

偏移不再从 ICU 的时区名字符串解析，而是用同一时刻的本地墙上时间减去 UTC 时刻，得到确定的分钟数后按 `UTC±HH:MM` 规范渲染。测试继续断言唯一正确值，不放宽成「两种写法都接受」。

## 根因

`formatUtcOffset` 用 `timeZoneName: "longOffset"` 读取 ICU 输出的时区名，再把 `GMT` 前缀替换成 `UTC`。Windows ICU 对 `UTC` 时区输出 `UTC`（而非 `GMT+00:00`），前缀替换未命中，于是返回裸 `UTC`；其他平台输出 `GMT+00:00` → `UTC+00:00`。同一输入因平台产生两种输出，断言只能二选一，等于放弃了对格式的约束。

## 修复

- `formatUtcOffset` 改用 `formatToParts` 的 year/month/day/hour/minute/second 数字部分组装「本地墙上时间对应的 UTC 时间戳」，与入参 `now` 取整秒后的 UTC 时间戳相减，四舍五入到分钟。
- 按 `UTC` + 符号 + 两位小时 + 两位分钟渲染；半小时偏移（`Asia/Kolkata` → `UTC+05:30`）和负偏移（`America/Los_Angeles` → `UTC-08:00`，本地日期为前一天）都得到同一个规范格式。
- 新增测试锁定这两种边界，防止回退到「从日期字符串或 ICU 名称推断偏移」。

## 曾考虑的替代方案

- **放宽断言，同时接受 `(UTC, UTC)` 与 `(UTC, UTC+00:00)`：** 舍弃。测试放弃对格式的约束，平台差异被掩盖，今后任何格式回退都不会被捕获。
- **对 `longOffset` 字符串做多模式归一化（匹配 `UTC`/`GMT`/`GMT±HH:MM`）：** 舍弃。仍依赖 ICU 可能新增的写法，且无法覆盖历史时区的秒级偏移；数值差值才是事实来源。
- **改用 `timeZoneName: "shortOffset"`：** 舍弃。同样受平台差异影响（UTC 可能输出 `GMT` 或 `UTC`），只是换一种脆弱字符串。
- **换一个 locale 规避：** 舍弃。问题出在时区名而不是数字部分的 locale，换 locale 不触及根因。

## 后果与防回退

- `Current local time: ... (<IANA>, UTC±HH:MM)` 是唯一允许的格式；新增时区用例必须断言精确字符串，不得写「包含 UTC」这类弱断言。
- 偏移由数值计算得出，`longOffset` / `timeZoneName` 字符串不得再进入这条渲染路径；若将来要支持秒级历史偏移，需扩展渲染格式并同步更新全部用例。
- 测试使用固定 `now` 与固定时区，不读取宿主机 `Intl` 默认值，避免再次引入平台相关断言。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/context/currentTime.test.ts`：8/8 通过（修复前 6/7，UTC 用例失败）。
- 全量 `pnpm verify` 退出码 0：11 个包 typecheck、lint、notes:check、db:check、发布 Profile、架构与设计令牌检查均通过；全部测试通过（agent 829/829、UI 365/365、desktop 378 passed / 2 skipped 等）。并发CI 下曾出现的 UI 异步等待与 Windows 临时目录 `EBUSY` 属测试标准问题，另见[异步 UI 与子进程测试的等待标准](../testing/2026-11-27-async-test-timeouts-and-process-teardown.md)。
