# Note：CLI TUI 工具展示模型与目录分层

状态：提案

## 实施进度

- W0 目录重组、W1 展示模型、W2 结构化输出、W3 CLI 适配已完成。
- W5 连续 Read/Grep 折叠已完成：`groupToolCalls.ts` 在单条 assistant 消息内折叠连续 read/search/list 工具，Ctrl+O 展开全部子工具。
- W4 桌面适配暂缓：桌面现有 renderer 已能读取结构化输出，暂不改为消费展示模型；不阻塞 CLI 复刻。
- 已补 CLI TUI 测试：Read 摘要不打印正文、Grep 折叠/展开、RunCommand 结果行、Edit Update/diff、Read/Grep 折叠组、折叠组高度估算。
- 尚未完成：W6 文档与旧 Note 路径同步、全量 `pnpm verify`、实机终端验收。

## 问题

CLI TUI 已经能跑通 coding 会话，但工具结果展示与 Claude Code 差距明显，且现有结构无法支撑多人并行维护。

**1. 工具结果被当成模型文本直接打印。**
`apps/cli/src/tui/components/ToolCard.tsx` 只有一个通用渲染器：读取 `part.output`，字符串直接截前 8 行，对象 `JSON.stringify` 后截前 1 600 字符（`ToolCard.tsx:207-215`、`ToolCard.tsx:127-137`）。实际运行时 Read/Grep/RunCommand/WriteStdin 的 `part.output` 是 `formatModelContent` 产出的模型可见字符串，于是：

- Read 把带行号的文件正文铺进 transcript，而不是一行 `Read N lines`；
- Grep 打印 `path:line:text`，没有匹配数摘要；
- RunCommand 只打印前 8 行，没有运行中 tail、耗时、空输出 `Done`/`(No output)`、`… +N lines (ctrl+o to expand)`；
- Edit 无条件展开最多 80 行 diff，而不是摘要 `+N -N`、按需展开；
- 连续 Read/Grep 不折叠，每调用一次占一整张卡。

**2. 同一个工具存在三套投影，无法保证 parity。**
桌面在 `packages/ui/src/components/tool-call/renderers/*` 里各自解析输出并渲染；CLI 在 `ToolCard.tsx` 里用另一套通用逻辑；非 TTY 在 `apps/cli/src/presentation/toolLine.ts` 里还有第三套 label/summary。新增或调整一个工具要同时改三处，任何一处漏改都会让同一会话在不同宿主上表现不一致。

**3. 数据契约不对称。**
`ToolEntry.exposeOutput` 目前只有 Edit 开启（`apps/agent/src/core/tool/builtin/edit.ts:97`），其他工具的事件载荷是模型字符串。UI 只能靠正则猜行数、匹配数和 shell 状态行；Read 的 `numLines`、RunCommand 的 `stdout/stderr` 本来在 handler 输出里就有，却在事件边界丢失。

**4. TUI 目录混合职责，阻碍并行。**
`apps/cli/src/tui/components/` 是 13 个文件的平铺目录，同时放 App 壳、虚拟列表、消息行、Markdown、工具卡、输入框、光标布局、Spinner、状态行和选区文本；`interaction/` 混合输入布局、指针、选区与剪贴板；`commands.ts` 混合命令类型、帮助文案和解析。按仓库规模预算（单目录约 12 个文件起按子职责拆分），这里已经超线；多人同时改工具展示、输入和滚动会集中冲突。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/tool-presentation/`（新增）：host 无关的工具展示模型与纯解析。
  - `packages/ui/src/components/tool-call/`：从“解析 + 渲染”改为“布局适配”，消费展示模型。
  - `packages/ui/package.json`：新增 `./tool-presentation` 子入口。
  - `apps/agent/src/core/tool/builtin/read.ts`、`grep.ts`、`shell/tools.ts`：开启 `exposeOutput`，保持 `formatModelContent` 与模型文本不变。
  - `apps/cli/src/tui/`：按职责重组目录；新增 `transcript/tool/ToolCall.tsx` 与 `ToolCallDetails.tsx`。
  - `apps/cli/src/presentation/toolLine.ts`：改为展示模型的非 TTY 适配器。
  - `scripts/architecture/architecture-check.mjs`：新增 `tool-presentation` 不得依赖 React/DOM/Ink 的守护。
  - `AGENTS.md`、`README.md`：同步目录表与导入边界（实施时）。
- UI/进程/协议/持久化表面：
  - 不新增 IPC 频道，不修改 `AgentCommand` / `AgentFrame`。
  - 事件 schema 的字段不新增；只改变 `part.output` 的运行时形态（结构化对象），并用兼容解析承接旧快照。
  - 不新增磁盘持久化；仍使用内存 store。
- 相关 Note：
  - [CLI Coding 模式与终端 UI 移植](./2026-11-12-cli-coding-mode-and-tui-port.md)
  - [工具调用卡片的统一 UI 架构](../../implemented/architecture/2026-11-09-tool-call-ui-architecture.md)
  - [CLI TUI 对话交互重建](../../implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md)
  - [Edit 多 hunk diff 展示](../../implemented/architecture/2026-11-10-edit-multi-hunk-diff-display.md)
  - [Agent 工具系统基础](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)
  - [统一会话消息投影](../../implemented/architecture/2026-11-06-unified-conversation-view-projection.md)

## 提案

### 总原则：四层，单一语义源

```text
Agent 工具输出契约（结构化 handler output）
        │  exposeOutput + formatModelContent
        ▼
工具展示模型 @answra/ui/tool-presentation（纯函数，无 React/DOM/Ink）
        │  ToolPresentation
        ├──────────────┬──────────────────┬──────────────────┐
        ▼              ▼                  ▼                  ▼
桌面 DOM 适配     CLI Ink 适配       非 TTY 文本适配      未来其他宿主
(ToolCallCard)   (ToolCall.tsx)     (toolLine.ts)
```

- **第 1 层：Agent 输出契约。** 工具的 handler 输出本来就有结构（`ReadOutput`、`GrepOutput`、`RunCommandOutput`、`ShellSessionSnapshot`）；开启 `exposeOutput` 让事件携带结构，同时用 `toModelOutput` + `formatModelContent` 保持模型文本逐字不变。UI 不再猜。
- **第 2 层：工具展示模型。** 唯一决定“这个工具在界面上是什么摘要、有没有结果行、能不能展开、展开是什么”的地方。纯函数，输出 plain data，不出现 React 节点、Ink 组件或 CSS 类名。
- **第 3 层：宿主适配。** 每个宿主只负责把 `ToolPresentation` 映射成自己的渲染原语。桌面保留既有中文文案、图标和 diff 卡布局；CLI 复刻 Claude Code 的 `⏺ Tool(目标)` + `  ⎿ 结果行` 语法；非 TTY 只取 `summary`。
- **第 4 层：TUI 基础设施。** 虚拟列表、输入、滚动、选区、状态行不感知工具语义；工具语义只从展示模型进入 `transcript/tool/`。

### 展示模型契约

```ts
export type ToolAction = "read" | "search" | "edit" | "create" | "write" | "run" | "other";
export type ToolCategory = "read" | "search" | "list" | "command" | "write" | "other";

export type ToolDetail =
  | {
      readonly kind: "text";
      readonly label?: string;
      readonly text: string;
      readonly wrap: boolean;
      readonly truncated: boolean;
      readonly totalLines?: number;
    }
  | { readonly kind: "diff"; readonly diff: EditDiffDisplay }
  | { readonly kind: "notice"; readonly tone: "muted" | "warning" | "error"; readonly text: string };

export interface ToolPresentation {
  readonly toolName: string;
  readonly action: ToolAction;
  readonly category: ToolCategory;
  readonly state: AgentToolCallState;
  /** 摘要主目标：文件名 / pattern / command / sessionId / fallback title。 */
  readonly primary: string;
  /** 摘要补充：路径、glob、workdir 等，宿主可只显示在展开区。 */
  readonly secondary?: string;
  /** 摘要尾部统计：+N -N、N matches、N files。 */
  readonly meta?: string;
  /** 工具结果行：Read N lines / Done / (No output) / … +N lines。 */
  readonly resultLine?: string;
  readonly errorText?: string;
  readonly details: readonly ToolDetail[];
  readonly expandable: boolean;
}

export interface ToolPresentationInput {
  readonly toolName: string;
  readonly state: AgentToolCallState;
  readonly input?: unknown;
  readonly inputText?: string;
  readonly output?: unknown;
  readonly errorText?: string;
  readonly title?: string;
}

export function presentToolCall(input: ToolPresentationInput): ToolPresentation;
```

`ToolPresentationInput` 是 `ConversationMessagePart` 与 `tool-execution-started/finished` 事件的公共最小形态，避免展示模型绑定某一种消息结构。

### 各工具的目标行为

| 工具 | 摘要 | 结果行 | 展开详情 |
| --- | --- | --- | --- |
| Read | `Read(<fileName>)` | `Read N lines`；`file_unchanged` 显示 `Unchanged since last read` | 无，不展示文件内容 |
| Grep | `Search(pattern: "...", path: "...")` | `Found N lines` / `Found N files` / `Found N files counted` | 匹配行或文件列表，受行数/字符上限约束 |
| Edit | `Update(<fileName>)` + `+N -N` | `Added N lines, removed M lines` | 既有 hunk diff 卡 |
| RunCommand | `Bash(<command>)` | 运行中 `elapsed · N lines`；完成 `Done` / `(No output)` / `… +N lines` | stdout/stderr 合并文本，首 3 行预览、展开完整 |
| WriteStdin | `Write(<sessionId>)` | 会话状态（running/completed/timed_out/killed） | 写入字符、stdout/stderr、退出码 |
| 未知工具 | `title ?? toolName` | 无 | 安全格式化的 input/output；失败只显示 `errorText` |

约束：

- Read 永不渲染文件正文；行数只来自结构化 `ReadTextOutput.numLines`。
- RunCommand 运行中的 `part.output` 仍是 `tool-output-delta` 拼接的字符串，展示模型按“运行中预览”解析；完成后优先结构化输出，字符串仅作兼容回退。
- 截断提示由模型给出 `truncated/totalLines`，具体显示几行由宿主决定：CLI 折叠 3 行、展开 200 行；桌面沿用自身高度上限。
- 摘要文本的终端宽度裁剪由 CLI 用 `string-width` 完成，模型不按 `.length` 截断，避免中文/emoji 错位。

### 目录调整

**现状问题目录：**

```text
apps/cli/src/tui/
  components/          # 13 个文件平铺：App、VirtualTranscript、MessageRow、MarkdownText、
                       # ToolCard、PromptInput、TextInput、Spinner、StatusLine、SelectableText...
  interaction/         # 输入布局 + 指针 + 选区 + 剪贴板
  commands.ts          # 类型 + 帮助文案 + 解析
  modelCommand.ts
  runTui.tsx
  theme.ts
  viewStore.ts
```

**目标结构：**

```text
packages/ui/src/tool-presentation/
  index.ts                 # 公开入口：presentToolCall、类型、limits
  types.ts                 # ToolPresentation / ToolDetail / ToolPresentationInput
  registry.ts              # toolName -> presenter，未知工具走 fallback
  present.ts               # 入口函数与通用摘要规则
  limits.ts                # 字符/行数上限与安全裁剪原语
  value.ts                 # asRecord / stringField / safe JSON
  tools/
    read.ts                # parseReadOutput + presentRead
    grep.ts                # parseGrepOutput + presentGrep
    edit.ts                # parseEditOutput + presentEdit
    runCommand.ts          # parseRunCommandOutput + presentRunCommand
    writeStdin.ts          # parseWriteStdinOutput + presentWriteStdin
    fallback.ts            # 未知工具的安全展示
```

```text
apps/cli/src/tui/
  runTui.tsx               # 入口：会话队列、取消、Ink render
  app/
    App.tsx                # 根布局 + 全局按键归属
    viewStore.ts           # snapshot/事件 -> TuiState，唯一 writer
  transcript/
    VirtualTranscript.tsx  # 视口、虚拟窗口、跟随滚动
    virtualLayout.ts       # 纯高度/窗口计算
    Transcript.tsx         # welcome / tail 投影
    MessageRow.tsx
    MessageResponse.tsx
    MarkdownText.tsx
    SelectableText.tsx
    tool/
      ToolCall.tsx         # 摘要 + 结果行 + 状态 + 展开入口
      ToolCallDetails.tsx  # ToolDetail[] -> Ink 原语
      groupToolCalls.ts    # 连续 read/search 折叠（阶段 2）
  composer/
    PromptInput.tsx
    TextInput.tsx
    inputLayout.ts         # 纯 grapheme/宽度布局
  chrome/
    StatusLine.tsx
    Spinner.tsx
    theme.ts
  interaction/
    pointerInput.ts
    selection.ts
    selectionStore.ts
    selectionActions.ts
    clipboard.ts
  commands/
    catalog.ts
    parse.ts
    dispatch.ts
    help.ts
    modelCommand.ts
    CommandPalette.tsx
```

拆分理由：

- `transcript/` 只回答“消息和工具长什么样”，不处理输入、进程或命令解析。
- `composer/` 只回答“用户怎么输入”，`inputLayout.ts` 与 `PromptInput` 同域演进。
- `chrome/` 只放全局视觉与运行态，不放消息内容。
- `interaction/` 只放终端交互原语；新增鼠标能力只改这里。
- `commands/` 把目录、解析、分派、帮助、候选面板与模型命令分开；`runTui.tsx` 只接线。
- 每个目录控制在 12 个文件以内；`transcript/tool/` 是工具展示的唯一落点，新增工具不改 transcript 其他文件。

### 桌面适配调整

`packages/ui/src/components/tool-call/` 保留布局能力，但删除各 renderer 里的解析逻辑：

- `ToolCallCard` 接收 `ToolPresentation`，统一渲染摘要、状态、`summaryExtra`、展开区。
- `ToolCallDetails` 把 `ToolDetail` 映射为现有 `ToolDetailSection` / `ToolOutputBlock`；`diff` 仍走既有 `EditDiffCard`。
- `renderers/*` 只保留真正需要不同布局的工具（Edit diff、RunCommand shell 面板）；其余工具使用通用卡。
- 桌面文案仍由桌面映射表维护（例如 `read → Read`、`search → 搜索`），展示模型只给语义，不强制语言。

### 非 TTY 适配调整

`apps/cli/src/presentation/toolLine.ts` 删除 `TOOL_LABELS` 与 `summarizeToolInput` 的第二套逻辑，改为：

```ts
const presentation = presentToolCall({ toolName, state, input, output });
const summary = formatSummaryLine(presentation); // 纯文本、无 ANSI
```

`tool-execution-started` 没有 output，用 `state: "running"` 生成摘要；`tool-execution-finished` 用完成态生成状态行。这样非 TTY 与 TUI 的摘要语义一致。

### 分阶段落地

**阶段 0：机械目录重组（独立 PR，无行为变化）**
- `git mv` 到目标目录，更新 import 与测试路径。
- 只允许重命名与移动；任何逻辑变化拆到后续 PR。
- 目的：先消除并行开发的冲突热点。

**阶段 1：展示模型 + 结构化输出（核心）**
- 新增 `packages/ui/src/tool-presentation/` 与 `./tool-presentation` 导出。
- 开启 Read/Grep/RunCommand/WriteStdin 的 `exposeOutput`，补 `toModelOutput` 往返测试。
- 展示模型同时支持结构化输出与旧字符串，兼容现有测试与内存快照。
- 新增架构守护：`tool-presentation` 不得 import `react`、`react-dom`、`ink`、`lucide-react`、CSS 或 `apps/agent`。

**阶段 2：宿主接入（CLI 已完成；桌面暂缓）**
- CLI `ToolCall` 消费展示模型，删除通用 `formatOutput` 的原始输出打印。
- 非 TTY 改为展示模型摘要。
- 桌面 renderer 改为消费展示模型，删除重复解析。当前暂缓：桌面现有 renderer 已能读取结构化输出，不改也不阻塞 CLI。
- 三个宿主可并行，互不改对方的渲染文件。

**阶段 3：折叠与展开增强（折叠组已完成；单卡展开未做）**
- `groupToolCalls.ts` 把连续 read/search/list 工具折叠为 `Read 3 files, searched 2 patterns`；运行中显示现在时与当前目标。
- 工具卡支持单卡展开；全局 Ctrl+O 继续作为“全部展开”。当前只实现全局 Ctrl+O。
- 该阶段只改 `transcript/tool/`，不触碰展示模型契约。

### 并行开发切分

| 工作流 | 主要文件 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| W0 目录重组（已完成） | `apps/cli/src/tui/**` | 无 | W1、W2 |
| W1 展示模型（已完成） | `packages/ui/src/tool-presentation/**`、`packages/ui/package.json` | 无 | W0、W2 |
| W2 结构化输出（已完成） | `apps/agent/src/core/tool/builtin/{read,grep,shell}` | 无 | W0、W1 |
| W3 CLI 适配（已完成） | `apps/cli/src/tui/transcript/tool/**`、`presentation/toolLine.ts` | W1、W2 | W4 |
| W4 桌面适配（暂缓） | `packages/ui/src/components/tool-call/**` | W1 | W3 |
| W5 折叠增强（已完成折叠组） | `apps/cli/src/tui/transcript/tool/groupToolCalls.ts` | W3 | W6 |
| W6 文档同步（进行中） | `AGENTS.md`、`README.md`、Note 迁移 | W0-W5 | 无 |

协作纪律：

- W1 先合并“类型 + 空实现 + 测试骨架”，让 W3/W4 可以按契约并行；W1 的实现可以随后补齐。
- W2 只改 `exposeOutput` 与测试，不改 UI；W3 不因 W2 未完成而修改 agent。
- 每个工具 presenter 一个文件 + 一个测试文件，新增工具的人只碰自己的文件。
- 目录重组与行为变化不得混在同一 PR，否则 review 无法区分“移动”与“改逻辑”。

### 明确不做

- 不新建 `packages/tui`：目前只有 CLI 一个终端宿主，Ink 原语没有第二个消费者；等出现第二个终端宿主或原语被复用时再抽取。
- 不把展示模型放进 `packages/shared`：它不是跨进程契约，而是 UI 语义；shared 继续只放事件、状态词汇与跨进程 schema。
- 不复制 Claude Code 的 `CollapsedReadSearchContent`、`MessageResponse` 等实现：只复刻行为与布局，不引入 `AppState`、feature flag、React Compiler 产物。
- 不在阶段 1 做审批 UI、消息操作、任务面板；这些是独立能力，另立 Note。内置 slash 命令候选与 Tab 补全已另立 [CLI slash 命令候选与 Tab 补全](../../implemented/feature/2026-11-13-cli-slash-command-palette.md)。
- 不让 CLI 解析任意 ANSI/正则猜测工具语义；结构化输出优先，字符串只作旧数据回退。

## 模块边界

- `packages/ui/src/tool-presentation/`：只依赖 `@answra/shared/schema` 的类型与 `editDiffDisplaySchema`；不 import React、react-dom、ink、lucide-react、CSS，也不 import `apps/agent`。工具输出用窄守卫解析 `unknown`。
- `packages/ui/src/components/tool-call/`：只做 DOM 布局、图标、文案与样式；不得重新实现 Read/Grep/RunCommand 的输出解析。需要新布局时只加 renderer 覆盖，不加解析分支。
- `apps/cli/src/tui/transcript/tool/`：只把 `ToolPresentation` 映射为 Ink 原语；不得包含工具输出解析、状态机或 Agent 事件判断。
- `apps/cli/src/tui/transcript/`：只处理消息顺序、虚拟化与滚动；不感知工具类别以外的业务语义。
- `apps/cli/src/tui/composer/`：只处理输入、光标、历史与粘贴；不读写 transcript 或工具状态。
- `apps/cli/src/tui/chrome/`：只处理全局视觉与运行态；不持有会话或工具状态。
- `apps/cli/src/tui/interaction/`：只处理终端指针、选区与剪贴板；新增鼠标能力只改这里。
- `apps/cli/src/presentation/`：非 TTY 纯文本投影；只调用展示模型，不复制工具标签与解析。
- `apps/agent/src/core/tool/`：继续只负责执行、预算与模型可见内容；`exposeOutput` 只影响事件载荷，不改变模型文本。Agent 不得 import UI。

## 曾考虑的替代方案

- **直接在 `ToolCard.tsx` 里加 Read/Grep/RunCommand 分支。** 舍弃。这样会形成桌面、CLI TUI、非 TTY 之外的第四套投影；新增工具仍要改多处，且 CLI 与桌面会继续漂移。
- **把展示模型放进 `packages/shared`。** 舍弃。shared 是跨进程契约层，放“Read 显示几行、结果行文案”会把 UI 语义带进事件协议；后续换 UI 或做本地化会被迫改 shared。
- **新建 `packages/tui` 承载 Ink 原语与展示模型。** 舍弃。当前只有 CLI 一个终端宿主，Ink 原语没有第二消费者；按“抽象等第二消费者”的纪律，先留在 `apps/cli/src/tui`，展示模型放已存在的 `@answra/ui` 子入口。
- **让 CLI 复制桌面 renderer 的解析代码。** 舍弃。桌面 renderer 依赖 React DOM、CSS 和 lucide 图标，直接复制既引入无关依赖，也产生第二份语义；后续修 bug 要改两处。
- **只加 `exposeOutput`，不调整 UI 结构。** 舍弃。数据变对了，但 CLI 仍会把结构化输出 `JSON.stringify` 或打印正文；用户看到的差距不会消失。
- **继续用字符串正则解析 Read 行数与 shell 状态行。** 舍弃。行号、`<system-reminder>`、`Exit code` 等格式属于模型可见文本，不是稳定 UI 契约；一旦 prompt 或预算逻辑调整，正则会静默失效。
- **直接照搬 Claude Code 的 `CollapsedReadSearchContent` 与消息折叠组件。** 舍弃。它依赖 Claude Code 的 `AppState`、feature flag、`Tool` 注册表与 React Compiler 产物，无法在 Answra 的 Ink 8 + 自有投影上维护；只借鉴“分类计数 + 当前目标 + ctrl+o”的行为。

## 验收标准

- 可观察结果：
  - Read 只显示 `Read <文件名>` 与 `Read N lines`，transcript 中不出现文件正文。
  - Grep 显示 pattern 与匹配数/文件数；默认不铺满匹配行，展开后受上限约束。
  - RunCommand 运行中显示已耗时与最后几行；完成后显示前 3 行与 `… +N lines`，空输出显示 `Done` 或 `(No output)`。
  - Edit 摘要显示 `+N -N`，diff 只在展开后出现。
  - 连续 Read/Grep 折叠为一行摘要；Ctrl+O 展开全部详情。
  - 非 TTY 的 `[tool]` 行与 TUI 摘要语义一致。
- 自动化验证：
  - `pnpm --filter @answra/ui test`：展示模型的每工具结构化/字符串回退、截断、空输出、失败；桌面 renderer 不回归。
  - `pnpm --filter @answra/cli test`：`ToolCall` 不打印 Read 正文、结果行、折叠/展开、CJK 宽度裁剪；非 TTY 摘要。
  - `pnpm --filter @answra/agent test`：`exposeOutput` 后 `formatModelContent` 与模型文本逐字不变，`tool-execution-finished` / `tool-result` 两条事件路径都携带结构化输出。
  - `pnpm architecture:check`、`pnpm notes:check`、`pnpm verify` 通过。
- 需要的实机验证：
  - VS Code 集成终端与 Windows Terminal：Read/Grep/RunCommand/Edit、长输出、中文/emoji、窗口 resize、PgUp/PgDn、Ctrl+O、单卡展开。
  - `--no-alt-screen` 下确认终端原生 scrollback 与工具摘要正常。

## 风险

- **`part.output` 形态变化。** 开启 `exposeOutput` 后旧测试、旧内存快照或第三方消费者可能仍按字符串处理；展示模型必须同时支持结构化与字符串，并在一个发布周期后再删除字符串回退。
- **事件路径覆盖不全。** `tool-execution-finished` 与 `tool-result` 都可能更新 part；实现前必须确认 AI SDK 6 的 `tool-result.output` 是 execute 返回值，并用测试压住“结构化输出不被字符串覆盖”。
- **架构守护遗漏。** `tool-presentation` 一旦被 `components` 的 DOM 依赖污染，CLI bundle 会悄悄变大；必须用 architecture-check 或单测扫描禁止导入。
- **目录重组冲突。** 机械移动会与正在进行的 TUI 修改冲突；W0 必须先合并，且 review 只看 rename，不夹带逻辑变化。
- **终端宽度与截断差异。** 模型返回完整有界文本，宿主各自裁剪；CLI 必须用 `string-width`，不能沿用 `.length`，否则中文摘要会超宽。
- **桌面文案与布局漂移。** 展示模型只给语义，桌面保留自己的中文文案与 diff 卡；接受“语义一致、文案不同”，但禁止桌面重新解析输出。
- **范围蔓延。** 折叠、单卡展开、审批、消息操作容易一起被拉进来；阶段 1 只做展示模型与三宿主接入，其余按阶段推进。
- **性能。** 展示模型会对大输出做一次规范化与裁剪；必须保留字符/行数上限，避免把完整 shell 输出或 diff 放进每次 render 的 memo 计算。
