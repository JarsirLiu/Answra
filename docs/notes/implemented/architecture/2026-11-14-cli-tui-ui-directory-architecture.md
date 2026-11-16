# Note：CLI TUI UI 目录与工具展示适配架构

状态：已实施

## 问题

CLI TUI 已经能展示 Read、Grep、Edit、RunCommand，但工具展示相关职责集中在少数文件里，继续增加行为会放大并行冲突：

- `ToolCall.tsx` 同时负责圆点/Spinner、摘要、结果行、失败状态、展开提示和详情入口；调整任意一项都要改同一个文件。
- `ToolCallDetails.tsx` 同时负责文本截断、运行中 tail、diff、notice 和行数常量；`headLines`/`tailLines` 已经计算 `hidden`，但渲染层没有使用，截断提示没有单一来源。
- `groupToolCalls.ts` 同时负责分类、去重计数、文案和运行态；`MessageRow.tsx` 同时渲染折叠组与单卡。折叠组的时态、顺序和当前目标无法单独测试。
- `presentation/toolSummary.ts` 与 `presentation/toolLine.ts` 各有一套 action 到 label 的映射，TUI 与非 TTY 输出可能漂移。
- 现有 4 个工具已经通过 `exposeOutput` 向事件提供结构化 output，工具执行与事件 schema 不是当前主要瓶颈；当前需要的是 CLI UI 的稳定边界和可并行文件划分。
- 桌面工具卡暂不调整，不能把 `packages/ui/src/components/tool-call/**` 卷入本次改动。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/transcript/tool/**`
  - `apps/cli/src/tui/transcript/MessageRow.tsx`
  - `apps/cli/src/tui/transcript/VirtualTranscript.tsx`
  - `apps/cli/src/tui/transcript/virtualLayout.ts`
  - `apps/cli/src/tui/app/App.tsx`
  - `apps/cli/src/tui/app/expansion.ts`（新增）
  - `apps/cli/src/tui/chrome/ToolLoader.tsx`（新增）
  - `apps/cli/src/presentation/toolLabels.ts`（新增）
  - `apps/cli/src/presentation/toolSummary.ts`
  - `apps/cli/src/presentation/toolLine.ts`
  - `packages/ui/src/tool-presentation/tools/runCommand.ts`
  - `apps/cli/test/tui/**`
  - `packages/ui/test/toolPresentation.test.ts`
- UI/进程/协议/持久化表面：
  - 不新增 IPC 频道，不修改 `AgentCommand` / `AgentFrame`。
  - 现有 5 个工具不修改事件 schema；只调整 CLI 的展示适配。
  - 不新增磁盘持久化，仍使用内存 store。
  - 不修改桌面 `packages/ui/src/components/tool-call/**`。
- 相关 Note：
  - [CLI Coding 模式与终端 UI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [CLI TUI 工具展示模型与目录拆分](../../proposed/architecture/2026-11-13-cli-tui-tool-presentation-and-directory-architecture.md)：本 Note 取代其中的目录拆分部分，原 Note 保留行为模型。
  - [工具调用卡片的统一 UI 架构](./2026-11-09-tool-call-ui-architecture.md)
  - [统一会话消息投影](./2026-11-06-unified-conversation-view-projection.md)
  - [Edit 多 hunk diff 展示](./2026-11-10-edit-multi-hunk-diff-display.md)

## 决定

### 总原则

保持四层，CLI 只做宿主适配：

```text
@answra/shared/schema
        ↓
@answra/ui/tool-presentation       纯语义：ToolPresentation / ToolDetail
        ↓
apps/cli/src/presentation          CLI 文案、非 TTY 投影
        ↓
apps/cli/src/tui/transcript/tool   Ink 布局适配
        ↓
MessageRow / VirtualTranscript / App
```

- `tool-presentation` 唯一决定工具语义：摘要目标、结果行、是否可展开、详情类型。
- CLI 只负责 glyph、缩进、行数限制、时态和展开提示，不重新解析 `part.output`。
- 一个工具一个 presenter；CLI 不按工具拆 `BashToolCard`、`EditToolCard` 等组件。
- 展示详情只按 `ToolDetail.kind` 分派为 `text`、`diff`、`notice`。
- 文案映射只有一个来源，TUI 与非 TTY 共用。
- 展开状态是纯 UI 状态，不进入 Agent、事件或 transcript。

### 目录结构

```text
apps/cli/src/tui/
├─ runTui.tsx                     # 组合根：会话队列、取消、Ink render（未改）
├─ app/
│  ├─ App.tsx                     # 根布局、全局按键、展开状态持有者
│  ├─ viewStore.ts                # snapshot/事件 -> TuiState，唯一 writer
│  └─ expansion.ts                # all + expandedIds，纯状态机
├─ chrome/
│  └─ ToolLoader.tsx              # 工具 Spinner，供单卡与折叠组共用
├─ transcript/
│  ├─ VirtualTranscript.tsx       # 视口、虚拟窗口、跟随滚动
│  ├─ virtualLayout.ts            # 纯高度与窗口计算
│  ├─ Transcript.tsx              # welcome / tail
│  ├─ MessageRow.tsx              # 消息与 part 顺序，不解析工具语义
│  └─ tool/
│     ├─ ToolCall.tsx             # 组合：Header + ResultLine + Details
│     ├─ ToolCallHeader.tsx       # 圆点/Spinner + label(target) + state
│     ├─ ToolResultLine.tsx       # `⎿` + result/error + 展开提示
│     ├─ ToolDetails.tsx          # ToolDetail[] 分派
│     ├─ toolLayout.ts            # glyph、缩进、预览/展开行数常量
│     ├─ details/
│     │  ├─ TextDetail.tsx        # 文本预览、运行中 tail、截断提示
│     │  ├─ DiffDetail.tsx        # hunk、行号与 diff 截断
│     │  ├─ NoticeDetail.tsx      # warning / error / muted
│     │  └─ previewText.ts        # 纯 head/tail/hidden 计算
│     └─ groups/
│        ├─ groupToolCalls.ts     # 纯分组
│        ├─ groupLabel.ts         # 时态、顺序、当前目标
│        └─ ToolGroupRow.tsx      # 折叠组渲染
```

共享语义层保持：

```text
packages/ui/src/tool-presentation/
├─ index.ts
├─ types.ts
├─ registry.ts
├─ present.ts
├─ limits.ts
├─ value.ts
└─ tools/
   ├─ read.ts
   ├─ grep.ts
   ├─ edit.ts
   ├─ runCommand.ts
   └─ fallback.ts
```

CLI 文案收口：

```text
apps/cli/src/presentation/
├─ toolLabels.ts     # 唯一 action / canonical -> CLI label 映射
├─ toolSummary.ts    # ToolPresentation -> { label, target, extra }
├─ toolLine.ts       # 非 TTY，复用 toolLabels
└─ streamPresenter.ts
```

### 职责边界

| 位置 | 职责 | 禁止 |
| --- | --- | --- |
| `ToolCall.tsx` | 组合 Header、ResultLine、Details | 判断工具名、解析 output、计算截断 |
| `ToolCallHeader.tsx` | 圆点/Spinner、粗体 label、target、失败状态 | 读取展开状态、渲染详情 |
| `ToolResultLine.tsx` | `⎿`、result/error、展开提示 | 决定工具语义、解析输出 |
| `ToolDetails.tsx` | 按 `ToolDetail.kind` 分派 | 读取 Agent 事件、判断工具类别 |
| `details/*` | Ink 布局、预览、截断、diff 行号 | 生成摘要、读取 `part.output` |
| `previewText.ts` | 纯 head/tail/hidden 计算 | 依赖 Ink 或 React |
| `groups/groupToolCalls.ts` | 纯分组 | 渲染、读取 stdin |
| `groups/groupLabel.ts` | 时态、顺序、计数、当前目标 | 渲染、读取 Ink 状态 |
| `groups/ToolGroupRow.tsx` | 折叠组布局 | 解析工具输出 |
| `app/expansion.ts` | `all` 与 `expandedIds` 状态迁移 | 读取 stdin、渲染 |
| `presentation/toolLabels.ts` | CLI action label 唯一映射 | 解析工具输出 |
| `presentation/toolLine.ts` | 非 TTY 文本投影 | 复制第二套 label |
| `packages/ui/tool-presentation/tools/*` | 工具语义与安全解析 | import Ink/React/Agent |

### 数据流

```text
ConversationMessagePart
        ↓
presentToolCall
        ↓
ToolPresentation
        ├─ summarizePresentation → ToolCallHeader
        ├─ resultLine/errorText → ToolResultLine
        └─ details[] → ToolDetails → TextDetail / DiffDetail / NoticeDetail
```

折叠组：

```text
parts[]
  ↓ groupMessageParts
ToolGroup { parts, presentations, running, failed, expandable }
  ↓ groupLabel(presentations, running)
{ label, currentTarget? }
  ↓
ToolGroupRow
```

展开：

```text
App
  ↓ expansion state
VirtualTranscript → MessageRow → ToolCall(expanded)
```

`ToolCall` 不读取 stdin；全局 `Ctrl+O` 调用 `toggleAllTools`。单卡展开只提供 `expandedIds` 状态接口，触发键或鼠标命中仍由后续 `interaction/` 设计决定。

### 展示策略

- **Bash 结果**：有输出时，输出作为 `⎿` 下的正文，不再追加冗余 `Done`；没有输出时显示 `(No output)`；超时显示 `Timed out`。运行中显示 `Running…` 与尾部输出。
- **截断**：折叠态文本 3 行、展开态 200 行；diff 折叠态 12 行、展开态 400 行；运行中命令尾部 5 行。所有截断必须显示 `… +N lines`；仅字符截断时显示 `… truncated`。
- **折叠组**：运行时使用现在时，结束后使用过去时；顺序固定为 search → read → list；运行中在结果行显示当前目标。计数口径由 `groupLabel.ts` 的测试固定。
- **单卡展开**：`app/expansion.ts` 维护 `all` 与 `expandedIds`；`ToolCall` 只接收 `expanded`，不自行读输入。
- **CJK 与宽度**：摘要裁剪继续使用 `string-width`，禁止用 `.length` 截断中文或 emoji。

### 明确不做

- 不修改桌面 `packages/ui/src/components/tool-call/**`。
- 不为现有 5 个工具新增 Agent 字段或事件 schema。
- 不在本轮增加 Write、Glob、Read image/notebook 或精确运行耗时；这些需要单独的 Agent 工具或 schema 提案。
- 不新建 `packages/tui`；当前只有一个终端宿主。
- 不在 CLI 内复制 presenter 的输出解析逻辑。
- 不把 Ink 组件放进 `packages/ui`。

## 模块边界

- `packages/ui/src/tool-presentation/`：只依赖 `@answra/shared/schema` 的类型与纯工具函数；禁止 React、react-dom、Ink、lucide-react、CSS 和 `@answra/agent`。
- `apps/cli/src/presentation/`：只做 label、summary 与非 TTY 文本；不依赖 Ink。
- `apps/cli/src/tui/transcript/tool/`：只把 `ToolPresentation` 映射为 Ink 原语；不得 import `apps/agent`、`src/session` 或 `node:fs`，不得解析 `part.output`。
- `apps/cli/src/tui/transcript/`：只处理消息顺序、虚拟化与滚动；不感知工具类别以外的业务语义。
- `apps/cli/src/tui/app/expansion.ts`：纯状态机；不读取 stdin，不渲染。
- `apps/cli/src/tui/interaction/`：终端指针、选区与剪贴板；不 import `transcript`。
- `apps/cli/src/tui/runTui.tsx`：组合根；本轮未拆分会话队列与配置面板处理，避免和工具卡改动混在一起。

## 曾考虑的替代方案

- **按工具拆 CLI 组件（ReadToolCall、BashToolCall、EditToolCall 等）：** 舍弃。工具语义已经在 `tool-presentation`，再按工具拆 CLI 组件会让新增工具同时修改 presenter、CLI 组件和测试，容易漂移。
- **把 Ink 组件和展示模型一起放进 `packages/ui`：** 舍弃。`@answra/ui` 是 DOM/React UI；Ink 属于 CLI 宿主，混放会把终端依赖带进桌面包。
- **新建 `packages/tui`：** 舍弃。当前只有 CLI 一个终端宿主，没有第二个消费者；等出现第二个宿主再抽取。
- **继续把全部逻辑留在 `ToolCall.tsx` / `ToolCallDetails.tsx`：** 舍弃。两个文件会继续膨胀，工具卡行为、截断和折叠组无法并行开发，测试也只能覆盖整体。
- **让 CLI 直接解析 `part.output`：** 舍弃。`ToolPresentation` 是唯一语义契约；CLI 再解析会形成第二套工具理解。
- **为现有 5 个工具补 Agent 字段以实现所有细节：** 舍弃。现有结构化输出已足够覆盖摘要、结果行、diff 和 shell 状态；Write/Glob、image/notebook、精确耗时另立提案。
- **桌面与 CLI 共用同一套布局组件：** 舍弃。桌面暂不改，且 DOM 与 Ink 的布局原语不同，共用会引入宿主判断。

## 验收标准

- 可观察结果：
  - `ToolCall` 只负责组合；Header、ResultLine、Details 可独立测试。
  - Bash 有输出时不再出现多余的 `Done`；空输出显示 `(No output)`；运行中显示尾部输出。
  - 文本、diff、运行中输出都有明确的 `… +N lines` 截断提示。
  - 折叠组运行时使用现在时、结束后使用过去时，顺序为 search → read → list，运行中显示当前目标。
  - 单卡可通过 `expandedIds` 展开；全局 `Ctrl+O` 仍能全部展开。
  - TUI 与非 TTY 使用同一套 action label。
- 自动化验证：
  - `pnpm --filter @answra/cli test`
  - `pnpm --filter @answra/ui test`
  - `pnpm typecheck`
  - `pnpm architecture:check`
  - `pnpm notes:check`
  - 新增测试按 `ToolCall`、`ToolDetails`、`previewText`、`groupLabel`、`expansion` 拆分。
- 需要的实机验证：
  - Windows Terminal 与 VS Code 集成终端。
  - 长输出、中文/emoji、窗口 resize、PgUp/PgDn、`Ctrl+O`、`--no-alt-screen` 下的 scrollback。

## 后果与防回退

- `ToolCall.tsx`、`ToolDetails.tsx`、`groupToolCalls.ts` 的单文件职责被拆开；后续新增工具只改 `tool-presentation` presenter，不新增 CLI 卡片文件。
- `toolLabels.ts` 成为 TUI 与非 TTY 的唯一 label 来源；禁止在 `toolLine.ts` 或 `ToolCallHeader.tsx` 重新定义 action label。
- `previewText.ts` 与 `toolLayout.ts` 成为截断行数和 `… +N lines` 的唯一来源；禁止在 Ink 组件里散落行数常量。
- `groupLabel.ts` 固定 search → read → list、时态和当前目标；禁止在 `ToolGroupRow.tsx` 里重写计数或时态。
- `expansion.ts` 是展开状态唯一 writer；禁止在 `ToolCall` 内使用 `useState` 保存展开状态。
- 单卡展开的触发键尚未接线；如果后续在 `interaction/` 增加触发，必须只调用 `toggleTool`，不能把 stdin 读取放进工具组件。

## 验证

- `pnpm --filter @answra/cli test`：45 个测试文件、267 个测试通过。
- `pnpm --filter @answra/ui test`：44 个测试文件、319 个测试通过。
- `pnpm typecheck`：本变更完成时 8 个 workspace 包通过；当前工作区并行 `apps/agent/src/conversation/application.ts` 与未跟踪 `conversationQueue.ts` 变更导致 CLI typecheck 失败，与本变更无关。
- `pnpm architecture:check`：8 个 workspace 包通过，无深导入、无环、无越界平台依赖。
- 本次变更相关文件通过 `biome check`；全量 `pnpm lint` 当前被并行未跟踪文件 `apps/agent/src/conversation/queue/conversationQueue.ts` 的格式问题阻塞，与本变更无关。
- 实机验证尚未执行：Windows Terminal/VS Code 终端的长输出、中文/emoji、resize、PgUp/PgDn、`Ctrl+O` 和 `--no-alt-screen` scrollback。
