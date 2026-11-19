# Note：CLI TUI 测试不再用墙钟猜测渲染完成

状态：已实施

## 问题

CLI 全量测试在并行负载下出现过两类失败，单独重跑又通过：

- `tui.streaming.test.tsx` 断言流式分片中的 `esc to interrupt` 重写次数 `≤4`，实际偶发为 5。
- `ConfigPanel` 在 `Right` 箭头后偶发仍停留在搜索态；同一序列单独跑通过。

两者都不是运行时行为随负载变化，而是测试把固定时间或次数当作渲染完成信号：

1. `Spinner` 自己每 120ms 重绘一次，与文本 delta 无关。旧断言把“流式 delta 不应重绘 spinner”混入墙钟预算：测试执行超过约 600ms 就多出一次合法动画 tick，`≤4` 必然失败。
2. `ConfigPanel` 测试在 `stdin.write` 后 `await setTimeout(0)`，假设 React 已提交上一帧。负载高时 `Down` 还没提交，紧随其后的 `Right` 仍走搜索态分支并被忽略；断言只看到旧的搜索 footer。

## 涉及范围

- 测试：`apps/cli/test/tui/app/tui.streaming.test.tsx`、`apps/cli/test/tui/panels/configPanel.test.tsx`
- 相关 Note：[CLI 流式输出时底部活动行闪烁](../bug-fix/2026-11-19-cli-streaming-status-flicker.md)、[pre-push 门禁不再依赖错误的时间假设](./2026-11-17-pre-push-test-stability.md)
- 运行时行为：无变化；只修测试机制。

## 决定

- 流式回归测试只冻结 `Spinner` 的动画定时器：`vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })`，`afterEach` 恢复真实定时器。基线帧之后的 `esc to interrupt` 重写次数断言为 `0`，不再保留任何墙钟容差。
- `ConfigPanel` 测试不再用 `setTimeout(0)` 推进输入；每次按键后等待可观察的 footer、焦点行或保存调用：
  - 列表态、API Key 行、编辑态分别用稳定的 footer 文案等待。
  - 上下移动用 `/[>›]\s*<label>/` 等待焦点落到目标行。
  - 保存结果直接 `vi.waitFor` `props.save` / `props.close` 的调用。
  - `Ctrl+U` 清空后先等待输入内容消失，再输入新值，避免在旧值上追加。
- 保留一个 `settle()` 只用于“Space 被忽略”这种没有正向可观察结果的负向断言；它不用于推进到下一次按键。

## 测试范围

- 流式增量渲染：10 个文本 delta 后 spinner 文案不得因 delta 重写，且分片不得出现整屏清除序列。
- 配置面板输入序列：搜索过滤、上下移动焦点、Enter/Right 进入编辑、API Key 显示/隐藏与保存、模型 ID 直接编辑与清空。
- 并行负载：完整 CLI 测试在默认 worker 数下执行，不依赖单文件重跑。

## 曾考虑的替代方案

- **把 `≤4` 放宽到更大的固定值：** 舍弃。tick 数随并行负载增长，任何固定上限都会被更慢的机器突破；也无法证明是 delta 导致的重绘。
- **直接 mock `Spinner`：** 舍弃。测试应覆盖真实 `Spinner` 与增量渲染的组合；冻结 interval 已能隔离动画，不需要替换组件。
- **把 `tick` 从 0ms 改成 20ms/100ms：** 舍弃。只是把竞态窗口推远，负载再高仍会失败。
- **减少 Vitest worker 数：** 舍弃。测试必须在当前并行度下成立，降并发只会掩盖问题。

## 验收标准

- 流式测试在没有动画 tick 干扰时，10 个 delta 后 spinner 文案重写次数严格为 0，且分片中没有 `ESC[1;1H ESC[J`。
- `ConfigPanel` 的每个输入步骤都以渲染后的 footer、焦点行或端口调用作为完成信号，不再以单次 0ms 等待作为完成信号。
- 全量 CLI 测试连续通过，不依赖单文件重跑。

## 风险

- `vi.waitFor` 默认每秒轮询多次；故障时最多等待 5 秒再失败，比原来的固定等待慢，但不会无限挂起。
- 冻结 `setInterval` 只作用于流式测试，`afterEach` 必须继续恢复真实定时器；否则后续使用真实 interval 的测试会被静默冻结。
- `settle()` 仍保留一处负向断言；它不能证明 Space 已被处理，只能证明没有观察到编辑态退出。需要证明输入被消费时应改用正向可见状态。

## 后果与防回退

- 断言“某动作没有导致重绘”时，必须先冻结与该动作无关的周期性动画；否则墙钟会变成隐式输入。
- 输入序列中，下一步按键前必须等待上一步的可见结果；`await setTimeout(0)` 不得作为 React 提交完成的证据。
- 覆盖输入被忽略的负向断言时，不要用 `vi.waitFor` 等待一个本来就不会出现的结果；保留短暂 settle 并明确其边界。
- 新增 TUI 测试时，优先复用 footer/焦点行等稳定文本作为同步点，不要新增基于帧数或时间的阈值。

## 验证

- `pnpm --filter @answra/cli test -- test/tui/app/tui.streaming.test.tsx`：1 个测试通过；冻结动画后基线之外无 `esc to interrupt` 重写。
- `pnpm --filter @answra/cli test -- test/tui/panels/configPanel.test.tsx`：10 个测试通过。
- `pnpm --filter @answra/cli test`：61 个测试文件、390 个测试通过。
