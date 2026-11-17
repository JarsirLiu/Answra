# Note：CLI TUI 统一通知中心

状态：已实施

## 问题

CLI TUI 的命令反馈目前共用一个 `store.setNotice(lines)` 字段，并在 `TranscriptTail` 常驻显示：

- 每个命令、面板动作、登录流程都直接 `setNotice` 拼字符串，没有统一的呈现组件与状态模型；
- notice 只有下一次 `setNotice`、`beginRun` 或 `reset` 才会被清掉，空闲时一旦出现就永久占住输入框上方；
- 成功、警告、错误没有 tone，全部使用同一种颜色；
- 多条反馈互相覆盖，后一条会直接挤掉前一条；
- `/help` 把整页帮助塞进 notice，既不能滚动，也不会消失。

Claude Code 的做法（本地源码 `src/context/notifications.tsx` + `src/components/PromptInput/Notifications.tsx`）是：

- 单一通知中心维护 `current + queue`；
- 每条通知有 `key`、`priority`、可选 `timeoutMs`，默认超时后自动移除并推进下一条；
- 相同 `key` 替换而不是重复堆叠；
- 渲染层只负责渲染当前通知，位置在输入框上方；
- 命令输出用 `key: "immediate-${name}"` 立即通知，`/status` 等对话框走 local-jsx 面板。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/notices/notification.ts`（新增）：通知类型、优先级与纯队列状态机。
  - `apps/cli/src/tui/notices/NotificationLine.tsx`（新增）：唯一通知渲染。
  - `apps/cli/src/tui/app/viewStore.ts`：持有通知队列与超时 timer，唯一 writer。
  - `apps/cli/src/tui/app/App.tsx`：把通知行放在 transcript 与输入框/面板之间。
  - `apps/cli/src/tui/commands/**`、`runTui.tsx`、`cli/codeCommand.ts`：改用 `store.notify`。
  - `apps/cli/src/tui/transcript/Transcript.tsx`、`VirtualTranscript.tsx`：移除 notice 渲染。
  - `apps/cli/src/tui/panels/HelpPanel.tsx`（新增）：`/help` 改为可滚动面板。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；不新增 IPC、协议或磁盘持久化。
  - 通知状态只存在内存，随 TUI 退出销毁。
- 相关 Note：
  - [CLI slash 命令候选与 Tab 补全](../../implemented/feature/2026-11-13-cli-slash-command-palette.md)
  - [CLI TUI 命令可用性策略与目录分层](../architecture/2026-11-17-cli-tui-command-access-policy.md)

## 决定

### 状态模型

```ts
export type TuiNotificationTone = "info" | "success" | "warning" | "error";
export type TuiNotificationPriority = "immediate" | "high" | "medium" | "low";

export interface TuiNotification {
  readonly key: string;
  readonly text: string;
  readonly tone?: TuiNotificationTone;
  readonly priority?: TuiNotificationPriority;
  /** 自动消失毫秒；null 表示阻塞式提示，必须显式移除。 */
  readonly timeoutMs?: number | null;
}

export interface TuiNotificationState {
  readonly current: TuiNotification | null;
  readonly queue: readonly TuiNotification[];
}
```

- 默认超时 `8000ms`，与 Claude Code `DEFAULT_TIMEOUT_MS` 一致。
- 相同 `key` 替换当前/队列中的同 key 通知，并重置计时；不会重复堆叠。
- `immediate` 插队：旧 current 退回队列，新的立即显示；其余优先级用于选择下一条。
- `timeoutMs: null` 只用于阻塞式提示（例如登录授权码输入），流程结束必须调用 `dismissNotification`。
- 队列状态机是纯函数（`addNotification` / `removeNotification` / `promoteNext`），不依赖 React、Ink 或计时器；timer 由 `viewStore` 单独持有。

### 渲染与位置

- `NotificationLine` 是唯一通知 UI：按 tone 取色，`info` 使用 dim，成功/警告/错误使用主题色。
- 位置固定在 transcript 与输入框（或面板）之间，不进入 transcript 内容，不参与滚动。
- 面板打开时通知仍可见；通知不抢输入焦点。
- 删除 `TuiState.notice`、`TranscriptTail` 的 notice 渲染以及 `VirtualTranscript` 的 notice prop。

### 消息路由

| 消息 | 表面 | key / 超时 |
| --- | --- | --- |
| 命令成功/拒绝/参数错误 | 通知 | `command` 或命令族 key，默认 8s |
| 命令异常 | 通知 error | `command-error`，8s |
| 登录进度/授权码 | 通知 | `login` 5s；`login-code` 为 `null`，输入后 dismiss |
| `/remote` 连接码 | 通知 info | `remote`，30s；再次执行 `/remote` 重新显示 |
| 运行失败 | 现有 `localError` | 保留，常驻到下一次 run |
| `/help` | 帮助面板 | 不再使用通知 |

### 明确不做

- 不做通知的折叠（`fold`）、通知点击关闭或鼠标交互。
- 不做桌面级系统通知，也不改 `@answra/ui` 的 `FloatingLayerHost`。
- 不把普通 prompt 排队行为改为通知。
- 不新增通知持久化或跨会话恢复。

## 影响表面

| 表面 | 变化 |
| --- | --- |
| 输入区上方 | 固定一行当前通知，不进入 transcript、不参与滚动；面板打开时仍可见 |
| 命令反馈 | 成功/警告/错误分别取主题色，默认 8 秒自动消失；同 key 替换，队列按优先级推进 |
| `/help` | 从常驻 notice 改为可滚动面板，Esc/Enter 关闭 |
| 登录/远程 | `login` 5 秒、`login-code` 阻塞式、`remote` 30 秒；流程结束时统一 dismiss |
| 协议/持久化 | 无变化；通知只存在 TUI 内存，退出即销毁 |

## 模块边界

- `notices/notification.ts`：纯类型与状态迁移；禁止 import Ink、React、store。
- `notices/NotificationLine.tsx`：只渲染当前通知；不持有队列、不创建 timer。
- `viewStore`：唯一的通知 writer 与 timer 持有者；`notify` / `dismissNotification` 是唯一入口。
- 命令 handler 只调用 `store.notify`，不得自行 `setTimeout` 清理。
- `runTui` 只负责把流程事件映射为通知，不直接渲染。

## 曾考虑的替代方案

- **保留 `notice` 并给它加一个统一的 `setTimeout`：** 舍弃。仍是单一字符串数组，多通知互相覆盖，无法区分 tone/优先级。
- **在 `TranscriptTail` 里继续渲染通知：** 舍弃。通知会随 transcript 滚动，且面板打开时被替换，失去“输入框上方固定反馈区”的一致性。
- **每次通知各写一个组件/样式：** 舍弃。正是本次要消除的重复 UI。
- **把 `/help` 继续放通知：** 舍弃。长内容无法滚动、无法阅读，改为面板和 Claude Code 的 `/help` 对话框一致。
- **直接搬运 Claude Code 的 `fold` / `jsx` 通知：** 本轮舍弃。当前没有合并需求，`jsx` 会把 Ink 组件塞进状态层；先保留纯文本，等第二个真实消费者再扩展。
- **所有通知都不超时，靠下一次操作覆盖：** 舍弃。正是用户反馈“提示不会消失”的根因。

## 验收标准

- 可观察结果：
  - 运行中 `/help`、`/status` 打开面板；被拒命令的原因提示 8 秒后自动消失，输入框上方恢复干净。
  - 连续执行两个命令时，第一条不会被第二条无声覆盖；队列按优先级依次显示。
  - 成功、警告、错误三种通知颜色不同。
  - `/help` 打开可滚动面板，Esc/Enter 关闭。
  - `/remote` 通知 30 秒后消失，再次执行 `/remote` 可重新看到连接码。
- 自动化验证：
  - `pnpm --filter @answra/cli test`
  - 新增 `test/tui/notices/notification.test.ts`（纯队列）、`notificationLine.test.tsx`（tone 映射）与 `test/tui/panels/helpPanel.test.tsx`；`viewStore.test.ts` 覆盖超时、阻塞与优先级。
  - 新增 `test/tui/commands/access.test.ts`，覆盖运行中放行/拒绝文案。

## 风险

- 通知超时会改变现有测试对常驻 notice 的断言；需要同步改为断言 `notification.current` 并显式推进计时器。
- 通告式提示（登录授权码）若忘记 `dismissNotification` 会一直显示；由 `login` 流程在 resolve 后统一清理。
- 通知行会占用 transcript 高度；超长文本使用换行，可能短暂压缩 transcript 视口。

## 后果与防回退

- `TuiState.notice` 与 `TranscriptTail` 的 notice 渲染已删除；不要再把命令反馈写回 transcript 或面板，否则会重新引入“提示常驻/随滚动丢失”的问题。
- 所有通知必须经 `viewStore.notify` / `dismissNotification`，handler 不得自行 `setTimeout`；否则队列与 timer 会出现多个 writer。
- 通知默认必须有超时；只有阻塞式流程（如登录授权码）可以传 `timeoutMs: null`，并必须在流程结束 dismiss。
- 新增通知 key 时优先复用命令族 key，避免同一流程的进度与结果互相堆叠。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/notices test/tui/commands test/tui/panels/helpPanel.test.tsx test/tui/runTui.test.ts`：8 个测试文件、69 个测试通过。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm architecture:check`：通过（9 个 workspace 包，无深导入、无环、无越界平台依赖）。
- `pnpm exec biome check apps/cli/src/tui apps/cli/test/tui apps/cli/src/cli/codeCommand.ts`：通过。
- 自动化覆盖：通知队列的替换/插队/优先级/超时/阻塞、viewStore 计时器推进、tone 主题映射、HelpPanel 关闭、运行中 `/status` 与 `/sessions` 放行、面板恢复被拒。
- 全量 `pnpm --filter @answra/cli test` 目前被并行进行中的图片粘贴改动阻塞（composer 2 个断言），与本变更无关；合并前需复跑全量。
