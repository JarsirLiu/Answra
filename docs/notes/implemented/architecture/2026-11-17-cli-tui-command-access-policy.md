# Note：CLI TUI 命令可用性策略与目录分层

状态：已实施

## 问题

CLI TUI 在 Agent 运行期间执行只读斜杠命令（如 `/status`）会被拒绝，提示还会误报成“修改模型配置”；同时“运行中能否执行”这条策略散落在多个调用点：

- `dispatch.ts` 的每个 handler 各自 `isBusy()` 并手写一份提示文案；
- `runTui.tsx` 的 `openPanel` 再判一次 busy，且对 `/status`、`/sessions` 复用模型配置文案；
- `modelCommand.ts` 与 `panelHandlers.resumeSession/selectModel` 又各判一次，文案各写一套；
- busy 由 `runTui` 本地变量与 `store.compactionActive` 组合而成，没有统一的运行时快照。

结果是新增一个命令要同时改多个文件才“碰巧正确”，团队并行开发时冲突集中在这几个大文件；用户侧则出现“只读操作被拒 + 文案不对”。

Claude Code 的做法是：`/status`、`/usage`、`/tasks` 在回复过程中立即执行，其余斜杠命令排队到本轮结束（见 Claude Code `src/context/notifications.tsx` 与 `/status` 的 immediate local-jsx 路径）。本仓库先对齐“只读立即执行、会改会话的操作必须空闲”的部分，不做命令排队。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/commands/catalog.ts`：命令元数据增加 access 声明。
  - `apps/cli/src/tui/commands/access.ts`（新增）：唯一可用性判定与提示文案。
  - `apps/cli/src/tui/commands/ports.ts`（新增）：命令族共享的窄端口。
  - `apps/cli/src/tui/commands/dispatch.ts`：唯一执行边界。
  - `apps/cli/src/tui/commands/handlers/*`（新增）：按命令族拆分。
  - `apps/cli/src/tui/panels/*`（从 `commands/` 迁出）：面板 UI 与面板动作契约。
  - `apps/cli/src/tui/runTui.tsx`：组合根接线，移除散落 busy 判断。
  - `apps/cli/test/tui/**`：访问策略、分派与面板动作测试。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI 与输入分派；不修改 Agent 事件、worker 协议、IPC、持久化或 desktop。
  - 不新增依赖；仍使用 Ink 8 与 React 19。
- 相关 Note：
  - [CLI slash 命令候选与 Tab 补全](../../implemented/feature/2026-11-13-cli-slash-command-palette.md)
  - [CLI TUI UI 目录与工具展示适配架构](../../implemented/architecture/2026-11-14-cli-tui-ui-directory-architecture.md)

## 决定

### 单一声明 + 单一策略

```text
catalog.ts     声明命令元数据与 access（always | idle-only + 动作名）
     ↓
parse.ts       文本 → invocation（纯函数）
     ↓
access.ts      access + TuiRuntime → 允许 | 唯一提示文案（纯函数）
     ↓
dispatch.ts    唯一命令执行边界：判一次 access，再分派
     ↓
handlers/*     命令族执行；不判 busy、不写第二套提示
     ↓
runTui.tsx     组合根：维护 busy/压缩状态、实现端口、接线
```

- `TuiAccess` 只有两种：`{ whileRunning: "allow" }` 与 `{ whileRunning: "deny", action }`。
- `TuiRuntime` 是 `{ runActive, compactionActive }` 快照；由 `runTui` 注入 `runtime()`。
- `accessDenial(access, runtime)` 返回 `undefined` 或唯一提示文案；运行中与压缩中使用不同措辞。
- 只读命令（`/help`、`/status`、`/sessions`）为 `allow`；会改会话/配置/账号/远程/退出的命令为 `idle-only`。
- `/sessions` 允许在运行中打开浏览，但面板动作“恢复会话”仍由 `PANEL_ACTION_ACCESS` 拦截。
- `openPanel` 不再判断 busy：能走到它说明命令已通过 access；面板本身不再决定可用性。
- `dispatch.ts` 的 `catch` 只把异常转成用户可读通知，不再由每个 handler 写 notice。

### 目录分层

`commands/` 现有 14 个文件，超过单目录预算；按职责拆为：

```text
tui/
├─ commands/
│  ├─ catalog.ts / parse.ts / access.ts / ports.ts
│  ├─ dispatch.ts
│  ├─ handlers/
│  │  ├─ session.ts    # new/clear/sessions/resume/delete/compact
│  │  ├─ model.ts      # config/model
│  │  ├─ account.ts    # login/logout/status
│  │  ├─ remote.ts     # remote
│  │  └─ meta.ts       # help/exit
│  ├─ help.ts
│  ├─ CommandPalette.tsx
│  └─ paletteLayout.ts
├─ panels/
│  ├─ panel.ts         # 面板种类、handlers、面板动作 access
│  ├─ ConfigPanel.tsx / ConfigList.tsx / configForm.ts / configPresentation.ts
│  ├─ ModelPicker.tsx / SessionsPanel.tsx / StatusPanel.tsx
│  └─ HelpPanel.tsx    # 新增：/help 从常驻 notice 改为面板
```

约束：

| 位置 | 只放 | 禁止 |
| --- | --- | --- |
| `catalog/parse/access` | 元数据、解析、纯策略 | Ink、React、store、session |
| `dispatch.ts` | 执行边界 | 具体命令实现、产品文案 |
| `handlers/*` | 单命令族执行 | 判断 busy、Ink/React |
| `panels/*` | 面板 UI 与本地交互 | 判断 busy、调用 session/runTui |
| `runTui.tsx` | 运行时状态、端口实现、接线 | 命令可用性规则、面板布局 |

### 明确不做

- 不把被拒命令排队到本轮结束；本轮只做“立即提示原因”。
- 不引入通用命令框架、自定义命令目录或 `$ARGUMENTS`。
- 不修改 `CodingSession` 的 run 语义，也不改队列中普通 prompt 的行为。
- 不新增 `packages/tui`。

## 模块边界

- `access.ts` 不读取 store，调用方传入 `TuiRuntime`，因此可在纯测试中穷举运行态。
- `ports.ts` 只放命令族共享的端口与 handler 类型；不 import Ink 组件或 `runTui`。
- `handlers/*` 只依赖 `ports.ts`、`@answra/shared` 类型与领域服务端口。
- `panels/*` 只依赖 `panel.ts` 契约、`viewStore` 类型与 Ink；不依赖 `commands/` 的执行实现。
- `runTui.tsx` 是唯一实现 `runtime()`、面板动作 gate 与远程状态端口的地方。

## 曾考虑的替代方案

- **继续在 handler 内判断 busy：** 舍弃。策略与文案继续分散，新增命令仍要改多处。
- **给 `openPanel` 增加 bypass 参数：** 舍弃。可用性以参数形式扩散，调用方仍需知道策略。
- **在 React 层用 context 判断 busy：** 舍弃。展示层会持有产品策略，且纯测试仍需 mock Ink。
- **把 `/sessions` 整体设为 idle-only：** 舍弃。浏览历史是只读操作，和 `/status` 同类；只拦恢复动作即可。
- **把所有命令都排队到本轮结束（Claude Code 对普通命令的做法）：** 本轮舍弃。需要扩展队列承载命令、顺序与取消语义，属于独立变更；先提供准确的即时反馈。
- **继续把所有面板放在 `commands/`：** 舍弃。目录超过预算，且命令语义与面板 UI 会被同一批并行改动同时触碰。

## 验收标准

- 可观察结果：
  - 运行中 `/status` 立即打开状态面板，不出现“修改模型配置”提示。
  - 运行中 `/help` 立即打开帮助面板。
  - 运行中 `/sessions` 可浏览；Enter 恢复被拒并给出“等待本轮结束/中断后”的提示。
  - 运行中 `/config`、`/model`、`/new`、`/clear`、`/resume`、`/delete`、`/compact`、`/login`、`/logout`、`/remote`、`/exit` 被拒，提示对应该命令。
  - 压缩中与运行中使用不同提示，且 Esc 语义保持可取消。
- 自动化验证：
  - `pnpm --filter @answra/cli test`
  - `pnpm typecheck`
  - `pnpm architecture:check`
  - 新增 `access.test.ts`，覆盖 allow/deny、run/compaction、面板动作。
- 需要的实机验证：
  - Windows Terminal 与 VS Code 集成终端中，运行中打开 `/status`、`/sessions` 后关闭面板，run 继续且排队 prompt 不被清空。

## 风险

- 面板替换输入框会暂时隐藏 composer；这是现有面板行为，本次不改变。
- `/sessions` 在运行中打开后，后台 run 结束会改变列表高亮；用户在面板内操作仍需以 action gate 为准。
- 目录迁移会移动测试路径；如果与并行分支冲突，以纯移动提交单独解决。

## 后果与防回退

- `dispatch.ts` 是唯一可用性判定点。新增命令只在 `catalog.ts` 声明 `access`，不得在 handler、面板或 `runTui` 里补 `isBusy` 分支。
- `access.ts` 是提示文案的唯一来源；拒绝文案不得在 handler 或面板中复制。
- 只读命令（`/help`、`/status`、`/sessions`）保持 `allow`；`/sessions` 的恢复动作由 `PANEL_ACTION_ACCESS` 拦截，不要为了省事把整个命令改成 `idle-only`。
- `panels/*` 只做 UI 与本地交互，不调用 session 或 `runTui`；`runTui.tsx` 只维护 `runtime()` 快照并实现端口。
- 迁移测试路径后，新增测试应放在对应的 `test/tui/commands/` 或 `test/tui/panels/` 下，避免重新堆回单一目录。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/commands test/tui/runTui.test.ts test/tui/panels`：通过（含新增 `access.test.ts`）。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm architecture:check`：通过（9 个 workspace 包，无深导入、无环、无越界平台依赖）。
- `pnpm exec biome check apps/cli/src/tui apps/cli/test/tui apps/cli/src/cli/codeCommand.ts`：通过。
- 自动化覆盖：运行中 `/status`、`/help` 放行；运行中 `/sessions` 打开后恢复动作被拒并给出统一文案；`/config` 等改动类命令给出对应 action 的拒绝文案；压缩与运行使用不同措辞。
- 全量 `pnpm --filter @answra/cli test` 目前被并行进行中的图片粘贴改动阻塞（composer 2 个断言），与本变更无关；合并前需复跑全量。
- 实机验证待补：Windows Terminal 与 VS Code 集成终端中，运行中打开 `/status`、`/sessions` 后关闭面板，run 继续且排队 prompt 不被清空。
