# Note：Mac 验证门禁的测试平台假设

状态：已实施

## 问题

执行 macOS Spaces 验证时，全量门禁被既有测试阻塞：Grep 用 Windows 分隔符访问 POSIX 文件，Shell 假设 `wc` 不填充空格，面试采集测试直接使用宿主平台。Shell 会话测试还未收窄 handler 的失败结果，导致全包类型检查失败。

## 涉及范围

- `apps/agent/test/core/tool/grep.test.ts`
- `apps/agent/test/core/tool/shell/shellTools.test.ts`
- `apps/desktop/test/interviewCaptureService.test.ts`
- `apps/desktop/test/interviewIpc.test.ts`

## 决定

测试使用当前平台的合法文件路径；Windows 仍覆盖混合分隔符。Shell 用整数格式输出 `wc` 的字节数，兼容 BSD 的空格填充，并明确检查 handler 的失败结果。Windows 专属面试测试显式模拟 Windows，结束时恢复宿主平台。

## 测试范围

只调整测试输入和平台环境，不改变 Grep、Shell 或面试采集的产品行为。macOS 面试采集仍不受支持；Windows mock 测试不代表 Mac 原生音频验收。

## 曾考虑的替代方案

- **跳过 Mac 上失败的用例：** 会减少回归覆盖，舍弃。
- **修改生产代码兼容测试输入：** POSIX 反斜杠是合法文件名，且面试采集尚无 Mac 实现；为使测试通过而扩展生产契约不符合当前范围，舍弃。

## 后果与防回退

本机平台不再决定 Windows 专属 mock 测试的结果；仍需在 Windows CI 验证真实 Windows 路径与 Shell 行为。

## 验证

macOS 15.6 / Apple Silicon、Node 22.23.4 下 `pnpm verify` 已通过：shared 11、Agent 409、UI 298、desktop 290 项测试通过，desktop 3 项按已有条件跳过；全包类型检查及架构检查通过。先前 worker host 的 token 刷新测试本次也通过，未修改该用例或其生产代码。
