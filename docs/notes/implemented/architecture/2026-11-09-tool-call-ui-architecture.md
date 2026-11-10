# Note：工具调用卡片的统一 UI 架构

状态：已实施

## 问题

Agent 已有的 `workspace.read`、`workspace.grep`、`workspace.run-command`、`workspace.write-stdin` 四个工具已经在 `general-chat` profile 中授权，工具事件和 transcript `parts` 也已进入 `packages/shared` 的既有 schema。但 renderer 侧没有对应的工具卡片：

- `ChatPanel` 只把 `message.text` / `message.reasoning` 交给 `AssistantMessage`，`message.parts` 中的 `kind: "tool"` 不参与渲染；
- `InterviewCapturePanel` 同样只渲染正文与思维链；
- `ReplyBarActivity` 是为答题跑马灯设计的扁平模型（`label + text`），没有 `state`、`input`、`output`、`errorText`，不能直接当工具卡数据源；
- `ToolResponse.tsx` 是标着“预留”的组件，全仓库没有渲染使用；
- 唯一能显示工具活动的 `ReplyConversationPopover` 属于答题回复详情，不是对话/面试的常驻消息流。

结果是：对话里模型调用了工具，用户只能看到最终回答，看不到“调用了什么、是否成功、结果是什么”；面试一旦授权工具也会遇到同样问题。若继续让每个面板自己解释工具事件，会迅速出现第二、第三套投影和卡片样式。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/app/conversationParts.ts`（新增）：事件 → `ConversationMessagePart[]` 的纯 reducer。
  - `packages/ui/src/app/conversationView.ts`：把 tool part 纳入唯一消息投影。
  - `packages/ui/src/components/chat/conversationMessage.ts`：给 `ConversationViewMessage` 增加稳定的 `parts`。
  - `packages/ui/src/components/chat/MessageTimeline.tsx`（新增）：按 parts 顺序渲染 text / reasoning / tool。
  - `packages/ui/src/components/chat/AssistantMessage.tsx`：支持 `parts` 入口，保留旧 `content/reasoning` 入口给答题回复详情。
  - `packages/ui/src/components/tool-call/`（新增）：统一卡片外壳、fallback、resolver 与各工具 renderer。
  - `packages/ui/src/components/panels/ChatPanel.tsx`、`InterviewCapturePanel.tsx`：接入 parts 渲染。
  - 删除 `packages/ui/src/components/chat/ToolResponse.tsx` 与 `ToolResponse.module.css`，并从 `chat/index.ts` 移除导出。
  - `packages/ui/src/app/useConversationChat.ts`：普通对话不再计算跑马灯 activities。
- UI/进程/协议/持久化表面：只改 renderer 渲染；不新增 IPC 频道、不修改 `packages/shared/src/schema/`、不改变 transcript 持久化格式。
- 相关 Note：
  - [统一会话消息投影](../../implemented/architecture/2026-11-06-unified-conversation-view-projection.md)
  - [Agent 标准工具系统与运行时执行管理](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)
  - [Shell 工具与会话运行时](../../implemented/feature/2026-11-09-shell-tools-and-session-runtime.md)
  - [事件 schema 单一来源与 AI SDK 边界](../../implemented/architecture/2026-11-03-event-schema-single-source.md)

## 决定

### 总原则

- **part 是唯一内容单位**：assistant 消息按 `ConversationMessagePart[]` 顺序渲染，不再从 `text + reasoning + activities` 反推顺序。
- **工具卡只有一层外壳**：`ToolCallCard` 统一处理摘要、展开、状态、错误和可访问性；工具差异只在 renderer。
- **执行记录采用扁平执行日志**：摘要行保持低密度（icon、动作词、内联等宽命令，无外层卡片）；`RunCommand` 展开内容使用单层描边终端面板承载 `Shell` 标签、命令和输出，不做「结果/退出码」多段堆叠，也不出现原生粗滚动条。
- **未知工具只落 fallback**：不把已知工具的原始 JSON 全量摊进消息流。
- **答题跑马灯不动**：`ReplyBarActivity`、`ReplyActivityTicker`、答题回复详情继续服务截图答题；答题没有工具，不需要工具卡。

### 目录与文件

```text
packages/ui/src/
  app/
    conversationParts.ts          # 纯函数：applyConversationPartEvent(parts, event)
    conversationView.ts           # snapshot + 事件 → ConversationViewMessage.parts
  components/
    chat/
      conversationMessage.ts      # ConversationViewMessage 增加可选 parts
      MessageTimeline.tsx         # parts 顺序渲染，连续同类 part 合并
      MessageTimeline.module.css
      AssistantMessage.tsx        # parts 入口；旧 content/reasoning 入口保留
      index.ts                    # 移除 ToolResponse
    tool-call/
      index.ts
      toolCallPart.ts             # ToolCallPart 类型与 renderer props
      ToolCallCard.tsx            # 唯一轻量行壳：摘要 + 可选展开
      ToolCallCard.module.css
      ToolCallDetails.tsx         # 展开后的 section / pre / notice 原语
      ToolCallFallback.tsx        # 未知工具兜底
      resolveToolCallRenderer.tsx # toolName → renderer，默认 fallback
      toolCallPresentation.ts     # 状态文案、状态判断、安全格式化
      toolCallContent.module.css
      renderers/
        read.tsx
        grep.tsx
        runCommand.tsx
        writeStdin.tsx
```

### 数据流

```text
ConversationSnapshot.messages[].parts ─┐
                                       ├─→ ConversationViewMessage.parts
AgentEventEnvelope.event ──────────────┘        │
                                               ▼
                                       MessageTimeline
                                         ├─ text      → TextResponse
                                         ├─ reasoning → ThinkingReasoning
                                         └─ tool      → resolveToolCallRenderer(toolName)
                                                          → ToolCallCard
```

`ConversationViewMessage` 增加：

```ts
parts?: ConversationMessagePart[]; // 投影结果始终提供；类型保持可选以兼容旧消息构造
```

- `applyConversationSnapshot` 优先使用 `snapshot.messages[].parts`；旧消息没有 `parts` 时，用 `text` / `reasoning` 合成两个 part。`applyAgentEvent` 的产物始终带 `parts`。
- `applyAgentEvent` 对 text / reasoning / tool 事件统一调用 `applyConversationPartEvent`。
- `text` / `reasoning` 字段继续保留，从 `parts` 派生，供跑马灯、回复详情和消息操作条使用；新 UI 不得再直接依赖这两个字段恢复顺序。
- `activities` 仍只服务答题跑马灯和回复详情；普通对话关闭 `trackActivities`。

### 卡片契约

```ts
export type ToolCallPart = Extract<ConversationMessagePart, { kind: "tool" }>;

export interface ToolCallRendererProps {
  part: ToolCallPart;
}

export interface ToolCallCardProps {
  part: ToolCallPart;
  icon: ReactNode;
  actionLabel: string;
  primary: ReactNode;
  secondary?: ReactNode; // 展开后显示的工作区/范围上下文
  meta?: ReactNode;      // 展开后显示的行数/匹配数/退出码
  children?: ReactNode;  // 展开详情；没有就不渲染展开按钮
}
```

`ToolCallCard` 的职责：

- 默认是一条 Codex 风格的扁平执行日志：终端 icon、动作词、内联等宽命令；不使用外层边框或卡片底色，不占固定宽度；
- 次目标和统计信息（目录、行数、匹配数、退出码、工作目录）移到展开区，避免摘要行堆信息；
- `part.state` 直接映射状态词；`completed` 不显示“完成”，只有非终态/失败态才在行尾显示；
- 运行态用文字扫光表达，不使用旋转 loading 图标；
- `failed` / `denied` 只把错误放在详情和状态词 `title` 中，**不自动展开**；
- 展开使用原生 `<button type="button" aria-expanded>`；整行可点，chevron 默认透明并紧跟在命令文本之后，hover/focus/展开时出现（展开时朝下）；摘要行不做 hover 换底色。
- 展开状态用组件内 `useState`，本期不做全局持久化；
- 没有 `children` 的卡片不可展开，不显示箭头；
- 展开区只在需要时显示，输出使用单层浅灰终端表面承载，不形成卡片套卡片。

状态词集中定义在 `toolCallPresentation.ts`：

```ts
const TOOL_CALL_STATE_LABEL: Record<AgentToolCallState, string> = {
  "input-streaming": "准备中",
  pending: "等待执行",
  "awaiting-approval": "等待确认",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  interrupted: "已中断",
  denied: "已拒绝",
};
```

### renderer 注册与兜底

`resolveToolCallRenderer` 按 wire name 查表：

```ts
const RENDERERS = {
  Read: ReadToolCall,
  Grep: GrepToolCall,
  Edit: EditToolCall,
  RunCommand: RunCommandToolCall,
  WriteStdin: WriteStdinToolCall,
};
return RENDERERS[part.toolName] ?? ToolCallFallback;
```

使用 `part.toolName` 而不是 `ToolId`：`ToolId` 是 Agent 内部身份，工具事件只携带模型 wire name。禁止从 `title` / `kind` / `raw` 正则猜工具语义。

### 工具 renderer 的显示内容

| 工具 | 摘要主目标 | 展开上下文 | 展开详情 |
| --- | --- | --- | --- |
| `Read` | 文件名（`input.file_path` 的 basename，`part.title` 兜底） | 无 | 无展开详情，不展示文件内容 |
| `Grep` | `pattern` | path / glob / 匹配数 | content 模式的文件与行；files 模式的路径；count 模式的计数 |
| `Edit` | 文件名 + `+N -M`（`Created` 时同样显示文件与统计） | 无（展开后摘要改为 `Edited file` / `Created file`） | 行级 diff：文件名与增删统计、复制按钮、旧/新行号、红绿整行底色和横向滚动 |
| `RunCommand` | 等宽 `command`（单行、超长省略） | 无（摘要不堆工作目录/退出码） | 单个描边 Shell 面板：`Shell` 标签、`$ 命令`、stdout/stderr；session 截断时补提示 |
| `WriteStdin` | `sessionId` | 会话状态 / 写入字符预览 | stdout、stderr、exitCode |
| 未知工具 | `title ?? toolName` | 无 | input / output 的安全格式化；失败时只显示 `errorText` |

`part.output` 是 `unknown`，renderer 内做窄结构守卫：

- Read：只从 `input.file_path` 取摘要，不解析 `part.output`；
- Grep：`type: "content" | "files_with_matches" | "count"`；
- Edit：结构化 `type: "edited"` + `replacements`，或模型可见的 `Replaced N occurrences` 回执；
- RunCommand：`kind: "result"` 或 `kind: "session"`；
- WriteStdin：`ShellSessionSnapshot` 形态。

解析失败不得抛错或白屏，必须回退到文本/JSON。大输出只渲染有上限的预览，并显示“已截断”或“仅显示前 N 条”。

### 面板接入

- `AssistantMessage` 增加可选 `parts`：传了就走 `MessageTimeline`；不传保持现有 `content` / `reasoning` 渲染，答题回复详情无需同步改造。
- `ChatPanel`：把每条 assistant 消息的 `parts` 传给 `AssistantMessage`。
- `InterviewCapturePanel`：同样传 `parts`；当前面试 profile 的 `tools` 为空，卡片不会出现，但接入是未来授权工具的前置条件。
- `MessageTimeline` 连续同类 part 合并：连续 reasoning 合成一个 `ThinkingReasoning`，连续 text 合成一个 `TextResponse`；遇到 tool part 时结束当前段并渲染卡片，保证“文字 → 工具 → 文字”的真实顺序。

## 修订：RunCommand 复刻参考 UI（2026-11-09）

问题：初版 `RunCommand` 展开态沿用 `ToolDetailSection("Shell")` + 灰底 `.shellBlock` + `ToolDetailSection("结果")` 三层堆叠，摘要行右侧常驻 chevron 且带 hover 底色，展开后还要单独显示工作目录与 `Exit code`；输出区使用浏览器默认滚动条，出现又粗又长的竖向滚动条。与参考实现（`>_ Ran <command>` 单行摘要 + 单个描边 `Shell` 面板）明显不一致。

根因（第一次改完仍然丑）：工具执行器 `registry.createModelTool` 的 `execute` 返回的是 `result.modelContent`（`formatModelContent` 产出的字符串），因此 UI 里 `part.output` 实际是 `"Exit code: 0\n<stdout>\n<stderr>"` 这类**字符串**，而不是 `{ kind: "result", result: {...} }`。旧 renderer 的窄结构守卫匹配不到，落到 `formatToolValue` 回退，把 agent 自带的 `Exit code` 行和原始输出整段铺进面板；滚动条则是因为同时写了 `scrollbar-width: thin`，Chromium 会忽略 `::-webkit-scrollbar` 细条规则而回落到系统粗条。

决定：

- 摘要行固定为 `[SquareTerminal] running|ran <command>`（2026-11-10 起由固定的 `Ran` 改为按状态显示）；命令单行省略，chevron 透明并紧贴命令尾部，仅 hover/focus/展开时可见，展开时朝下；摘要行不再 hover 换底色。
- 展开态只渲染一个 `.shellPanel`：与摘要行左缘对齐（抵消 `.body` 的 22px 缩进）、`max-height: 240px` 硬上限、1px `--glass-line` 描边、8px 圆角、淡色 `--chat-card-bg` 底；内部依次是 `Shell` 标签、`$ 命令` 与输出合并的等宽 `<pre>`。
- `Shell` 标签和输出文本用左右 `--space-4` 内边距，但面板本身左右不设内边距，使 `<pre>` 的竖向滚动条贴住面板右缘，而不是缩在内容区里。
- `parseShellOutput` 同时接受运行时真实字符串和旧结构化对象：字符串形态按 `formatShellResult` 的固定格式剥掉首尾 `Exit code: …`、`Command completed successfully with no output.` 与超时说明，并去掉命令输出开头的空行，只保留真正的 stdout/stderr；不支持的行原样保留，避免误删命令自身的输出。
- 不再单独展示 `workdir`、`Exit code`、`结果` 段落；失败/会话截断只保留 `ToolErrorBlock` 与 `ToolNotice`。
- 输出 `<pre>` 用 `white-space: pre`：命令行和表格输出保持单行，宽度不足时横向滚动，而不是折行把内容上下挤在一起；竖/横滚动条都只写 `::-webkit-scrollbar` 4px 细条（与 `.conversation` 同规格），不再声明 `scrollbar-width`，避免细条规则被标准属性覆盖。

舍弃方案：

- **保留「结果 / Exit code」分段并把输出再套一层灰底：** 舍弃，正是叠层和色块让展开态显得笨重，且参考实现没有这些段落。
- **摘要行右侧固定展示 chevron：** 舍弃，参考实现的 chevron 只在交互/展开时紧贴命令出现，常驻右对齐会让所有历史行都多一个视觉锚点。
- **展开面板用 `--paper` 白底：** 舍弃，白底在对话灰背景上过亮、更像独立卡片；参考实现是同底细描边面板。
- **只按结构化 `{kind:"result"}` 解析：** 舍弃，运行时 `part.output` 是 `modelContent` 字符串，结构化守卫永远匹配不到；必须同时兼容字符串形态。
- **在 UI 用正则猜测并删除任意 `Exit code` 行：** 舍弃，只剥离开头/结尾的状态行，命令自身输出里的同名行保持原样。

后果与防回退：`RunCommand` 的展开结构只允许一个 `.shellPanel`；`workdir`/退出码不得重新塞回摘要或另起 section；新增输出形态仍在 `<pre>` 内合并，不得再引入第二层卡片或系统粗滚动条。自动化证据为 `toolCallRenderers.test.tsx` 的 RunCommand 用例：运行时字符串 `"Exit code: 0\nhello\nwarn"` 展开后 `pre` 文本为 `$ npm test\nhello\nwarn` 且不含 `Exit code`，无输出字符串只显示 `$ dir`。

## 修订：RunCommand 运行态与展开底色（2026-11-10）

问题：`RunCommand` 展开后的 `.shellPanel` 只有描边、没有底色，在对话背景上像一块悬空内容；运行中摘要行同时出现 `Ran` 和中文 `运行中`，且命令文本静止，不符合“运行中只显示 running、完成后显示 ran，命令本身动态脉冲”的反馈要求。

决定：

- `.shellPanel` 使用 `background: var(--chat-card-bg)`，与工具调用其他表面共用同一淡色令牌；保留 1px `--glass-line` 描边和 8px 圆角，不引入第二层卡片。
- `RunCommand` 的摘要动作词由 `part.state` 决定：`isToolCallRunning(part.state)` 为真时显示小写 `running`，其余终态显示小写 `ran`。
- 运行中与完成态都不再额外显示生命周期词（`running`/`ran` 已描述动作）；失败/中断/拒绝仍保留状态词和错误 `title`。
- 运行中给命令主文本加 `data-running`，复用 `.state` 的文字扫光动画；完成后移除 `data-running`，命令恢复静态文本。
- `ToolCallCard` 新增可选的 `showState` 与 `pulsePrimary`，只由 `RunCommand` 覆盖；RunCommand 仅在失败/中断/拒绝时开启状态词，其他工具维持原有状态词与静态主文本。

舍弃方案：

- **保留 `Ran` + 中文“运行中”双标签：** 舍弃，状态词重复且中英文混杂，用户需要的是单一 `running`/`ran`。
- **对命令使用旋转 loading 或额外图标：** 舍弃，既有工具卡约定是文字扫光，不加第二个视觉锚点。
- **把底色做成独立 `--paper` 白底或高对比色块：** 舍弃，会像卡片套卡片，破坏扁平执行日志；必须复用对话表面令牌。
- **全局把主文本都改成脉冲：** 舍弃，Read/Grep 的路径与 pattern 不是运行命令，只在 RunCommand 开启 `pulsePrimary`。

后果与防回退：RunCommand 的摘要只能出现一个动作词（`running` 或 `ran`），运行中不得再渲染“运行中”，完成态不得再渲染“完成”；失败/中断/拒绝仍必须显示状态词。`.shellPanel` 必须保留淡色背景；命令脉冲必须继续复用 `tool-call-shine`，不得换成旋转图标。自动化证据为 `toolCallRenderers.test.tsx` 的运行态用例（`running`、无“运行中”、命令 `data-running`）、完成态无“完成”和失败态保留“失败”，以及 `themeCss.test.ts` 的背景/脉冲 CSS 守卫。

## 修订：统一展开面板与真实输出投影（2026-11-10）

问题：只有 `RunCommand` 的展开态是左缘与摘要行对齐的淡色描边面板；`Read`、`Grep`、`WriteStdin`、`Edit`、fallback 仍沿用 22px 缩进的 `.section + .label + 灰底 pre`，展开后标签和内容整体向右缩进，滚动条也缩在内容区里，与 Shell 面板明显不对齐。实际运行时 `Read`/`Grep`/`WriteStdin` 的 `part.output` 是 `formatModelContent` 产出的字符串，renderer 的结构化守卫匹配不到，纷纷回退到「结果」原始文本；截图中的 `Read` 因此把 `<system-reminder>` 与原始行号直接铺在灰块里。

决定：

- `ToolDetailSection` 统一成唯一的 `.panel` 表面：与摘要行左缘齐平、`max-height: 240px`、1px `--glass-line` 描边、`--chat-card-radius` 圆角、`--chat-card-bg` 淡色底；`.body` 取消 22px 左缩进，所有工具不再通过负 margin 抵消缩进。`Edit` 的 diff 面板保留自己的表头与行级 diff 结构，但复用同一淡色描边表面并取消负 margin。
- 面板内部分成标签和滚动内容：标签左侧 `--space-4` 内边距；内容区统一承担纵向/横向滚动与 4px 细滚动条；正文 `<pre>` 只负责字体、换行和左右内边距。Shell 形输出用 `data-wrap="false"` 保持单行横向滚动。
- `Read`、`Grep`、`WriteStdin` 同时支持结构化旧快照和运行时真实字符串：`Read` 剥离开头 `<system-reminder>` 后显示行号内容并把提醒放进通知；`Grep` 按 `output_mode` 选择「匹配/文件/计数」面板并保留 ripgrep 文本行；`WriteStdin` 解析 JSON snapshot 字符串。`RunCommand` 继续使用同一面板，只是标签为 `Shell`。
- 错误、通知、上下文行也统一到同一左缘：通知和 context 使用 `--space-4` 内边距；Grep 行列表不再套第二层灰底，直接落在共享面板里。

舍弃方案：

- **只把 `.body` 缩进改小：** 舍弃，解决不了各工具自带的灰底 section、标签层级和滚动条位置，仍会出现第二套表面。
- **只调整 `Read` 一个 renderer：** 舍弃，`Grep`/`WriteStdin`/`Edit`/fallback 会继续各自缩进，用户很快会看到下一处不对齐。
- **让 agent 直接返回结构化 output 给 UI：** 舍弃，当前 AI SDK 工具结果需要模型可见字符串；为 UI 改线协议会同时改变模型上下文，超出 UI 表面修正范围。
- **在 UI 用正则删除 `<system-reminder>` 之外的任意行号：** 舍弃，只解析 `formatReadOutput` 的固定开头提醒；文件正文中的 `<system-reminder>` 字样不被误删。

后果与防回退：除 `Edit` 自有的行级 diff 面板外，所有需要展开详情的工具只能通过 `ToolDetailSection` 生成 `.panel`；任何工具都不得再使用 `margin-left: -22px`、独立灰底块或第二层卡片。`ToolOutputBlock` 的 `data-wrap` 是 Shell 单行与普通换行的唯一开关；Grep/WriteStdin 的运行时字符串输出必须继续由 renderer 解析，不能退回「结果」原始文本。自动化证据为 `toolCallRenderers.test.tsx` 的 Grep 字符串与 WriteStdin JSON 用例，以及 `themeCss.test.ts` 对 `.panel` 背景/描边、`.body` 无 22px 缩进和命令脉冲的守卫。

## 修订：Read 只保留摘要（2026-11-10）

问题：`Read` 展开后仍显示行数和「内容」面板，把整段文件正文铺进对话；用户明确不需要在工具卡里查看文件内容，参考 UI 只有 `Read <文件名>` 单行摘要，既没有行数，也没有展开 chevron。

决定：

- `ReadToolCall` 只保留摘要：`FileText` 图标 + `Read` + `fileName(input.file_path)`，`part.title` 兜底；不传 `children`，因此卡片不生成展开按钮、`aria-expanded`、上下文行或 `.panel`。
- 摘要主目标由完整路径改为文件名，保持参考图的单行紧凑形态；路径不再进入卡片可视文本。
- 失败仍由 `ToolCallCard` 显示状态词与 `errorText` title，不自动展开，也不为了错误重新引入详情面板。
- Read 不再解析 `part.output`，删除内容、提醒、截断和行号投影 helper；`Read` 不再是统一展开面板的接入方。

舍弃方案：

- **保留折叠的内容面板、只是默认不展开：** 舍弃。用户明确不要文件内容，留下展开入口仍会增加 chevron 和误点成本。
- **只隐藏行数、保留内容面板：** 舍弃，没有满足「不要显示内容」。
- **继续显示完整路径：** 舍弃，参考图用文件名；摘要保持单行，避免长路径挤压工具行。
- **在摘要补一个行数或截断提示：** 舍弃，这正是用户要求移除的冗余信息；截断仍存在于模型可见输出，不进入 UI 摘要。

后果与防回退：`ReadToolCall` 不得重新传入 `meta` 或 `children`，不得渲染文件内容、行数、`[data-tool-panel]` 或展开按钮；工具失败只通过摘要状态和 `errorText` title 表达。自动化证据为 `toolCallRenderers.test.tsx` 的 Read 摘要/无展开/不渲染内容用例，以及 `ChatPanel.test.tsx`、`InterviewCapturePanel.test.tsx` 对 `Read` + 文件名的断言。

## 修订：Edit 摘要与行级 diff（2026-11-10）

问题：Edit 摘要仍使用「编辑 + 完整路径」，增删统计只藏在展开后的 diff 头；展开后摘要仍保留路径和统计，与参考 UI 的折叠态 `Edited <文件> +N -M`、展开态 `Edited file` 不一致，收起时也无法快速判断改动量。

决定：

- 摘要动作词为 `Edited`；当 `old_string` 为空且能生成 diff 时使用 `Created`。主目标为文件名，摘要尾部显示 `+N -M`，统计直接来自 `buildEditDiff`。
- 展开后主目标切换为 `file`，摘要尾部统计隐藏；完整文件名与 `+N -M` 进入 diff 面板头，避免摘要和面板重复。
- `ToolCallCard` 新增可选 `summaryExtra`、`expandedPrimary`、`expandedSummaryExtra`；它们只改变摘要呈现，开合状态仍由卡片自身 `useState` 唯一持有。
- diff 面板复用淡色描边表面：表头为文件名、`+N -M` 与复制按钮；行级 diff 使用旧/新行号、红色删除行、绿色新增行和整行底色；内容区允许横向滚动，滚动条保持 4px 细条。
- `Edit` 的行级 diff 面板保留自己的表头与行布局，不套 `ToolDetailSection` 的 `.panel` 标签结构。

舍弃方案：

- **折叠态只显示文件名、改动量放展开态：** 舍弃，用户需要在收起时直接看到 `+N -M`。
- **展开态继续显示文件名和统计：** 舍弃，与参考的 `Edited file` 展开态不一致，且 diff 表头已经有同样信息。
- **只做摘要、不复刻 diff 行：** 舍弃，参考展开态的核心是行号、红绿整行底色和横向滚动。
- **把 `Created` 也做成独立渲染器：** 舍弃，输入和 diff 形态与 Edit 相同，仅动作词不同。

后果与防回退：折叠态必须出现文件名与 `+N -M`；展开态摘要必须是 `Edited file` / `Created file`，统计只留在 diff 表头；不得移除旧/新行号、整行红绿底色或复制按钮。自动化证据为 `toolCallRenderers.test.tsx` 的 Edit 折叠/展开、`Created`、行号与复制用例，以及 `editDiff.test.ts` 的 diff 行号推导。

## 模块边界

- `app/conversationParts.ts` 是纯函数，只依赖 `@answra/shared` 的事件与 part 类型；不引 React、DOM、bridge 或 agent 包。
- `app/conversationView.ts` 仍是唯一消息投影入口；新增事件只改这里和 `conversationParts.ts`，不得到面板里复制 reducer。
- `components/chat/conversationMessage.ts` 是中立消息模型；`components` 不得反向依赖 `app/`。
- `components/chat/MessageTimeline.tsx` 是唯一把 part kind 分派到 text / reasoning / tool 的地方；面板只组装，不写工具判断。
- `components/tool-call/` 只依赖 React、lucide 和 `@answra/shared` 的公开类型；禁止 import `apps/agent` 或 `@answra/desktop`。
- 工具输出结构不进入 `shared`：本期由 UI renderer 做窄守卫；若后续工具输出成为跨进程稳定协议，再单独提案迁移。
- 不新增 `ToolId` 到 UI：wire name 是事件里唯一可用的身份；`ToolId` 仍只属于 Agent 进程。

## 曾考虑的替代方案

- **复用 `ReplyBarActivity` 作为工具卡数据源：** 舍弃。它只有 `label + text`，没有 `state`、`input`、`output`、`errorText`，无法表达“运行中/失败/可展开”，也无法做结构化结果；它只适合答题跑马灯。
- **把 part reducer 放进 `packages/shared`，让 agent transcript 与 UI 共用：** 本期舍弃。它能消除重复，但会把 UI 实时态和 agent transcript 状态机绑在一起，还要改动 `apps/agent/src/core/transcript/memoryStore.ts` 与 shared 的运行时逻辑，超出本次 UI 范围。当前先由 `conversationView` 持有 UI 投影；若出现第三次实现或两边状态开始漂移，再单独提取。
- **整体照搬 ZCode 的 `ToolLayout` / `renderers` / `ToolCallBlocks`：** 舍弃。ZCode 有几十个工具、Workflow/CUA/Session 编排和复杂的 display schema；Answra 当前只有四个 workspace 工具，照搬会引入大量无用抽象。只借鉴“统一外壳 + 注册表 + fallback”的分层。
- **未知工具也直接渲染结构化 JSON：** 舍弃。已知工具会重复展示模型已经看过的内容，长输出还会撑爆消息流；只有 fallback 在无法识别工具时才展示格式化 JSON。
- **保留 `ToolResponse` 占位组件并逐步改造：** 舍弃。它没有状态、错误、展开和流式输入，且当前无任何调用方；继续保留只会形成第二套卡片入口。
- **让人工智能回复详情也立即切到 parts：** 本期舍弃。答题没有工具，popover 仍依赖 activities 和 `retainCapturedRound`；先保持现状，避免一次改动同时触碰答题链路。

## 后果与防回退

- 已实现的可观察结果：
  - 普通对话触发 `Read` / `Grep` / `RunCommand` / `WriteStdin` 时，消息流按真实顺序出现 Codex 风格扁平执行日志：终端 icon、动作词、内联等宽命令；不占固定宽度。
  - 完成态不显示“完成”；只有运行/等待/失败/中断/拒绝等非终态在行尾显示状态。
  - 整行可点击展开；chevron 默认透明，hover/focus/展开时出现；失败详情不自动展开。
  - 次目标与统计信息（目录、行数、匹配数、退出码、工作目录）移到展开区，摘要保持单行。
  - 未知工具仍走 fallback，不把整段 `JSON.stringify(part)` 铺进消息流。
  - 面试面板具备同样的 parts 渲染能力；截图答题的跑马灯、回复详情和现有交互不变。
- 防回退约束：
  - `conversationView.ts` + `conversationParts.ts` 是唯一事件投影；面板不得自行累加 text / reasoning / tool。
  - `MessageTimeline` 是唯一按 part kind 分派的位置；工具差异只放 renderer。
  - 工具摘要保持紧凑；工作目录、统计和输出放在摘要下方的单层 Shell 表面，禁止嵌套卡片或固定宽度。
  - 快照初始化只信 `parts`，实时事件按 revision 连续应用；不能回退到单独累加 `text`。
  - `part.output` 是 `unknown`，各工具 renderer 的窄守卫必须配测试；工具输出一旦变更，必须同步更新 renderer 和 Note。
  - 大输出继续受字符数、行数和高度上限约束，超限必须显示截断提示。
  - `AssistantMessage` 保留旧 `content/reasoning` 入口；答题 popover 不切换 parts。
  - `useConversationChat` 只在 `operation === "answer.run"` 开启 activities；普通对话不再复制一份活动投影。

## 验证

- 自动化：
  - 2026-11-10 统一面板修订：`toolCallRenderers` 覆盖 Grep content/files 字符串、WriteStdin JSON snapshot 与共享 `data-tool-panel`；`themeCss` 覆盖 `.panel` 底面/描边和 `.body` 取消 22px 缩进。
  - 2026-11-10 Read 摘要修订：`toolCallRenderers` 断言 Read 只显示 `Read` + 文件名，无行数、无内容、无展开；`ChatPanel`、`InterviewCapturePanel` 同步断言 `Read` + `a.ts`。
  - 2026-11-10 Edit UI 修订：`toolCallRenderers` 覆盖折叠态 `Edited a.ts +1 -1`、展开态 `Edited file`、`Created`、行号 diff 与复制；`editDiff.test.ts` 覆盖 Read 行号前缀；全量 UI 288 项通过，`tsc --noEmit` 通过。
  - 2026-11-10 RunCommand 表面修订：`pnpm --filter @answra/ui exec vitest run` 276 项通过（`toolCallRenderers` 覆盖 `running`/`ran` 与命令 `data-running`，`themeCss` 覆盖面板底色与命令脉冲）；`pnpm lint`、`pnpm --filter @answra/ui typecheck` 通过。
  - `pnpm verify`：通过（lint、typecheck、全仓测试、架构检查）。
  - `pnpm lint`：通过（biome check 全仓无 fix）。
  - `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/agent typecheck`：通过。
  - 全仓测试：UI 253、agent 341、desktop 277 全部通过；本次新增/扩展的 `conversationParts`、`conversationView`、`ToolCallCard`、`toolCallRenderers`、`MessageTimeline`、`ChatPanel`、`InterviewCapturePanel` 覆盖 part 状态迁移、text→tool→text 顺序、紧凑摘要、完成态不显示状态、展开/失败不自动展开、四个 renderer 与未知工具兜底。
  - `pnpm architecture:check`、`pnpm notes:check`：通过。
- 重点用例：
  - `conversationParts.test.ts`：text / reasoning / tool 各状态迁移，未知事件返回 `undefined`；
  - `conversationView.test.ts`：快照 parts、实时 tool 事件、text→tool→text 顺序、终态 settle、无重复正文；
  - `ToolCallCard.test.tsx`：紧凑摘要、非终态状态、完成态隐藏状态、失败不自动展开、无详情不可展开；
  - `toolCallRenderers.test.tsx`：四个工具的摘要与展开详情、未知输出回退、失败输出、截断提示；
  - `MessageTimeline.test.tsx`：part 顺序与连续同类合并；
  - `ChatPanel.test.tsx`、`InterviewCapturePanel.test.tsx`：assistant 消息中出现紧凑工具行。
- 实机验证（合入前执行）：
  - `pnpm dev:full` 下在普通对话分别触发 `Read`、`Grep`、`RunCommand`、`WriteStdin`，确认行高、截断、展开、状态和失败展示与正文风格一致；
  - 截图答题确认跑马灯和回复详情没有变化；
  - 面试在未授权工具时确认没有空行或布局跳动。
