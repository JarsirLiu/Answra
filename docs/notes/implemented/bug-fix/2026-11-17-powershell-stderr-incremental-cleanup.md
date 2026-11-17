# Note：PowerShell 会话 stderr 增量清理不丢错误消息

状态：已实施

## 问题

全量并行 `pnpm verify` 和 pre-push 多次在 `apps/agent/test/core/tool/shell/sessions.test.ts` 的 `removes the PowerShell script echo and location block from session stderr` 失败。失败时清理后的 stderr 只剩两行 `[Console]::...`，真正的中文错误消息消失。单独运行该用例通常通过，连续推送时却反复出现，说明问题不是简单的机器慢，而是流式快照存在时序缺陷。

## 涉及范围

- 代码/模块：`apps/agent/src/core/tool/builtin/runCommand/process/sessionOutput.ts`、`apps/agent/src/core/tool/builtin/runCommand/shell/runtime.ts`
- 测试：`apps/agent/test/core/tool/shell/sessionOutput.test.ts`、`apps/agent/test/core/tool/shell/sessions.test.ts`
- 相关 Note：[Shell 工具与会话运行时](../feature/2026-11-09-shell-tools-and-session-runtime.md)、[Shell 会话等待在中断/超时后及时唤醒](./2026-11-10-shell-session-abort-wait.md)

## 决定

当 PowerShell 会话的原始 stderr 已经出现脚本回显前缀、但进程尚未结束时，快照暂不输出 stderr，也不推进 `stderrEmittedChars`；进程结束后再对完整 stderr 做 `stripPowerShellErrorWrapper` 并一次性输出清理结果。原生命令的 stderr 不受影响，继续按增量输出。

## 根因

`snapshotSession` 每次对累计的 `stderrRaw` 重新执行 PowerShell 清理，再按上一次清理结果的长度切出增量：

1. 并行负载下第一次快照只收到脚本回显前缀，清理函数尚未检测到完整错误包装，于是把前缀当作普通 stderr 输出，并把 `stderrEmittedChars` 推进到前缀长度。
2. 后续 chunk 到达后，完整 stderr 被清理成更短的中文错误文本，长度小于已推进的游标。
3. 下一次 `slice(stderrEmittedChars)` 从错误文本末尾之后开始，结果为空；模型和测试只看到早先泄露的前缀，真正错误消息永久丢失。

清理结果不是单调增长文本，不能继续用清理后长度作为增量游标。

## 修复

- 在 `shell/runtime.ts` 增加 `hasPowerShellScriptEchoPrefix()`，只判断原始 stderr 是否以固定脚本回显开头。
- `snapshotSession` 检测到“PowerShell + 回显前缀 + 会话仍运行”时返回空 stderr，并保持游标不变；会话结束后清理完整 stderr，再按正常增量输出。
- 将快照所需字段收窄为 `SessionOutputState`，测试可以直接构造最小状态，覆盖“先收到前缀、后收到完整错误”的跨快照场景。
- 新增 `sessionOutput.test.ts` 回归测试，验证前缀阶段不输出、完成阶段保留 `中文错误` 且不包含 `[Console]::`。

## 曾考虑的替代方案

- **每次快照都返回完整清理后的 stderr：** 舍弃。会破坏会话增量语义，模型每次轮询都收到重复 stderr，长日志会放大上下文。
- **逐 chunk 独立清理：** 舍弃。PowerShell 包装和错误消息可能跨 chunk，逐块清理无法判断边界，容易把错误正文或包装行单独留下。
- **只重跑或放宽该测试：** 舍弃。失败对应真实的输出丢失路径，重跑只会把缺陷藏起来，模型在慢机器上仍可能看不到错误消息。
- **所有 PowerShell stderr 都缓冲到进程结束：** 舍弃。会把正常原生命令的 stderr 也延迟到结束，影响长命令实时反馈；当前只缓冲已确认是脚本回显前缀的 stderr。

## 验收标准

- PowerShell 会话在收到回显前缀、尚未结束时，快照 stderr 为空，下游不会看到未清理的脚本回显。
- 会话结束后，清理结果包含真实错误消息，且不包含 `[Console]::`、`CategoryInfo`、`FullyQualifiedErrorId` 等包装。
- 普通原生命令 stderr 仍按原有增量路径输出。
- 自动化验证：新增 `sessionOutput.test.ts` 通过；shell 测试通过；完整 `pnpm verify` 连续两次通过。

## 风险

- 已确认是 PowerShell 脚本回显的 stderr 会延迟到进程结束才可见；这是为了避免丢失错误消息而接受的取舍。
- 只有原始 stderr 以固定回显前缀开头时才进入缓冲，普通 PowerShell 原生 stderr 不走该分支。
- 未来若修改回显前缀或清理规则，必须同步更新 `hasPowerShellScriptEchoPrefix()` 与回归测试，否则可能重新出现非单调游标。

## 后果与防回退

- 清理后的文本长度不能作为跨快照游标；任何会重写前缀的流式清理都必须保证输出前缀单调，或在重写期间暂停推进游标。
- 被暂缓的 stderr 不得推进 `stderrEmittedChars`，否则后续完整错误仍会被切掉。
- 新增 PowerShell 包装格式时，先补跨快照单元测试，再改清理函数。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/sessionOutput.test.ts test/core/tool/shell/sessions.test.ts test/core/tool/shell/shellTools.test.ts`：3 个文件、40 个测试通过。
- `pnpm verify`：连续两次完整通过，包含 lint、全包 typecheck、全包测试、架构守护和 tokens 检查。
- 回归用例覆盖前缀快照、完成快照和真实 PowerShell `Write-Error` 会话。
