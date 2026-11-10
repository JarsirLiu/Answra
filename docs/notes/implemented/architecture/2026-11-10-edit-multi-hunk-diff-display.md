# Note：Edit 多段 diff 展示与工具结构化输出

状态：已实施

## 问题

当前 Edit 展开卡只有变更行，没有变更前后的原文；参考的 ChatGPT 桌面应用会显示类似：

```text
292      error: "Cannot connect to API",
293  -   messages: [{ id: "run-1", ... }],
293  +   messages: [{ id: "run-2", ... }],
294    };
```

这不是 CSS 颜色问题。当前链路是：

- `apps/agent/src/core/tool/builtin/edit.ts` 的 `EditOutput` 只有 `filePath / replacements / replaceAll / lineEndings / sizeBytes`，没有可展示的 diff。
- `apps/agent/src/core/tool/registry.ts` 的 `createModelTool.execute` 只返回 `result.modelContent` 字符串，所以 `tool-execution-finished` 事件里的 `result.output` 也是这段模型文本。
- `packages/ui/src/components/tool-call/renderers/edit.tsx` 只能从 `old_string / new_string` 计算 diff；这两个字段不包含文件中的前后上下文，也无法表达 `replace_all` 命中多个位置时的多段变更。

因此继续在 UI 里修样式只能得到“一段没有上下文的红绿块”。要让展开卡和参考 UI 一致，必须由 Edit 工具产出**带上下文的 hunks**，并通过事件把结构化结果送到 renderer。

## 涉及范围

- Agent：
  - `apps/agent/src/core/tool/builtin/edit.ts`：生成展示用 hunks。
  - `apps/agent/src/core/tool/contracts.ts`：工具输出暴露标记。
  - `apps/agent/src/core/tool/registry.ts`：结构化输出与 `toModelOutput`。
  - `apps/agent/src/core/tool/builtin/editDisplayDiff.ts`（新增）：有界行 diff 与 hunk 合并。
- 共享契约：
  - `packages/shared/src/schema/toolDisplay.ts`（新增）：`EditDiffDisplay` / hunk / line 的运行时 schema 与类型。
  - `packages/shared/src/schema/index.ts`：稳定导出。
- UI：
  - `packages/ui/src/components/tool-call/renderers/edit.tsx`
  - `packages/ui/src/components/tool-call/renderers/editDisplay.ts`
  - `packages/ui/src/components/tool-call/renderers/editDiff.ts`
  - `packages/ui/src/components/tool-call/renderers/edit.module.css`
  - 相关 renderer / theme CSS 测试。
- UI/进程/协议/持久化表面：只改变 `tool-execution-finished.result.output` 中 Edit 的展示数据；不新增 IPC 频道、不新增事件类型、不把 patch 写进模型可见内容、不改 transcript 持久化格式。
- 相关 Note：
  - [工具调用卡片的统一 UI 架构](./2026-11-09-tool-call-ui-architecture.md)
  - [事件 schema 单一来源](./2026-11-03-event-schema-single-source.md)
  - [Markdown 与代码块滚动条过粗](../bug-fix/2026-11-10-markdown-scrollbars-too-thick.md)

## 决定

### 目标

Edit 卡片使用一个白底 diff 卡显示所有变更段：

- 每段包含变更前后各 3 行原文。
- `replace_all` 命中多个位置时输出多个 hunk；相邻或过近的 hunk 合并，远处的 hunk 之间显示“N 行未修改”分隔行。
- 行号在横向滚动时 sticky 在左侧；行号、左侧 3px 色条和整行淡红/淡绿底色共同表达增删。
- 模型看到的工具结果保持现有文本不变；结构化 diff 只供 UI 展示。
- 历史事件仍带字符串 output 时可以降级为当前的单段 diff，不白屏。

### 数据结构

在 shared 中定义展示契约，不在 UI 里手工猜字段：

```ts
export type EditDiffLineKind = "context" | "removed" | "added";

export interface EditDiffLine {
  readonly kind: EditDiffLineKind;
  readonly text: string;
}

export interface EditDiffHunk {
  readonly oldStart: number; // 1-based，包含上下文的第一条旧行
  readonly oldLines: number;
  readonly newStart: number; // 1-based，包含上下文的第一条新行
  readonly newLines: number;
  readonly lines: readonly EditDiffLine[];
}

export interface EditDiffDisplay {
  readonly hunks: readonly EditDiffHunk[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}
```

`EditOutput` 增加 `diff: EditDiffDisplay`；`formatEditOutput` 仍只输出原来的 “The file … has been updated successfully…”，不把 hunks 送进模型上下文。

`lines` 使用显式 kind，而不是 ZCode 风格的 `"+" / "-" / " "` 前缀字符串，避免文件内容本身以 `+`、`-` 或空格开头时产生解析歧义。`oldLines/newLines` 与 hunk 头一致，UI 可据此计算段间未修改行数，也可在运行时校验 hunk 完整性。

### Agent 生成多段

在新增的 `editDisplayDiff.ts` 中实现纯函数：

```text
full before text + full after text
  → normalize LF
  → trim common line prefix/suffix
  → bounded line diff of the changed middle
  → expand each change by 3 context lines
  → merge ranges whose unmodified gap ≤ 6 lines
  → assign oldStart/newStart and oldLines/newLines
```

关键约束：

- 使用**完整文件**的前后文本，而不是只用 `old_string/new_string`；这是支持 `replace_all` 多段和真实上下文的唯一可靠来源。
- 公共前后缀先裁掉；LCS 只处理变更区间，避免对大文件做全量 O(n×m)。
- 超过 `MAX_LCS_CELLS` 时不做大矩阵，退化为该区间的整段删除 + 整段新增，并设置 `truncated`；不能阻塞 Agent。
- 最多保留 `MAX_HUNKS` 段、`MAX_DIFF_ROWS` 行、`MAX_DIFF_CHARS` 字符；超限既截断 hunks 又显示提示。`MAX_HUNKS`/`MAX_DIFF_ROWS` 是显示预算，不影响磁盘写入。
- 上下文窗口在文件头/文件尾自然收窄；hunk 行号从完整文件的实际行号推导，不能用数组下标冒充。
- hunk 合并条件使用未修改间隔 `≤ 6`（两倍上下文），避免一次替换被切成多个只隔一两行的小块。
- CRLF 与 BOM 不参与展示行号：沿用 Edit 读取/写回时的规范化结果。

### 结构化输出如何过进程边界

不新增事件类型，也不把 patch 塞进 `modelContent`。使用 AI SDK 6 已有的 `tool.toModelOutput`：

1. `ToolEntry` 增加 `exposeOutput?: boolean`，仅 Edit 设为 `true`。
2. `createModelTool.execute` 在成功且 `exposeOutput` 为真时返回 `result.output`（即 `EditOutput`），否则继续返回 `result.modelContent` 字符串。
3. 所有工具都提供 `toModelOutput`：字符串 output 原样作为模型文本；结构化 output 调用工具的 `formatModelContent`。这样 Edit 的模型上下文与今天完全一致。
4. 业务失败仍返回 `result.modelContent` 字符串，保持失败链路不变；AI SDK 的 `tool-execution-finished.result.output` 对 Edit 变成结构化对象，其他工具仍是字符串。
5. UI 在边界用 shared 的 `editDiffDisplaySchema.safeParse(output.diff)` 收窄；解析失败回退到现有的 `old_string/new_string` diff，不抛错。

这样 `AgentEventEnvelope` 的 `output: unknown` 不需要改 schema，也不需要把展示类型扩散到事件 envelope；shared 只新增一个可独立测试的展示数据契约。

### UI 渲染

一个卡片、一个表头、一个滚动面，不为每个 hunk 重复文件名和复制按钮。

- 表头：文件名 + 总 `+N -M` + 复制按钮；多 hunk 统计为全部 hunk 的总和。
- Hunk：按 `oldStart/newStart` 初始化行号；`context` 同时递增旧/新行号，`removed` 只递增旧行号，`added` 只递增新行号。
- 段间分隔：显示 `⋯ 12 行未修改`；不显示行号、不染红绿。没有间隔时不显示。
- 行号列 `position: sticky; left: 0`，横向滚动时保持可见；颜色仍按当前 CSS 令牌。
- 段内每行左侧 4px 色条、整行 `--diff-remove-bg` / `--diff-add-bg`、同色行号；参考 ZCode 的 14% 行底色、18% 行号槽和 inset 色条，但保留我们当前的实际文件行号。
- 复制按钮本期不改成 patch 复制，继续复制 `new_string`；多段只改变展示，不改变复制契约。后续若要复制完整 patch，另立 Note。

ZCode 可以参考的部分：

- `apps/zcode-cli/packages/contracts/src/tools/write.ts` 的 `structuredPatch: DiffHunk[]`。
- `packages/ui/src/components/ui/lightweight-diff-preview.tsx` 的行底色、行号槽、sticky gutter。
- `packages/ui/src/components/ui/EditInlineDiffContent.tsx` 的轻量预览路线。

不直接采用 `@pierre/diffs` / Shiki / Shadow DOM：ZCode 的完整 diff 面板需要 worker 和语法高亮，消息流里的 Edit 只需轻量 hunk；直接搬会增加首帧开销和新的依赖边界。

### 实际实施结果

- shared 新增 `toolDisplay.ts`：`editDiffDisplaySchema` 使用 strict object，`hunks` 至少 1 段；hunk 行号 1-based，line kind 为 `context/removed/added`。
- `buildEditDisplayDiff(before, after)` 读取完整文件前后文本，公共前后缀裁剪后只 diff 变更区间；LCS 上限 `MAX_LCS_CELLS=400_000`，上下文 `3` 行，未修改间隔 `≤6` 行合并，最多 `20` 段、`600` 行、`20_000` 字符，单行裁剪到 `2_000` 字符。
- Edit 成功写盘后把规范化 complete before/after 交给生成器，`EditOutput.diff` 与原有回执字段一起返回；磁盘失败路径不生成 diff，也不改变失败回执。
- `ToolEntry.exposeOutput` 是通用布尔契约，只有 Edit 开启；`registry.createModelTool.execute` 对 exposed 成功结果返回结构化对象。`toModelOutput` 用工具的 `formatModelContent` 生成模型文本，因此模型上下文仍是短回执，其他工具和失败结果继续返回字符串。
- `EditDiffDisplay.hunks` 的空数组会被 shared schema 拒绝；Edit 当前无变化时直接报错，不发送空展示。
- UI 优先用 `safeParse(output.diff)`，失败或旧事件则回退 `buildEditDiff(old_string, new_string)`；`editDisplay.ts` 只负责 shared hunk 到视图行号的投影。
- 已知实现细节：`toModelOutput` 当前重新调用 `formatModelContent`，没有复用 `executeToolCall` 已预算化的 `modelContent`；仅 Edit 暴露结构化输出且回执很短，暂不扩大通用契约。
- 实际自动化验证：shared 11 项、Agent targeted 30 项、UI targeted 45 项、UI 全量 294 项通过；`pnpm typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check` 通过。
- `pnpm verify` 未全绿：agent 的 shell/VAD 用例在并行负载下超时；单独重跑后 VAD 通过，shell 仍有 1 个 PowerShell stderr 用例返回 `running`。该链路不经过 Edit diff；桌面实机 sticky/多段视觉验证也尚未完成。

### 实施顺序

1. shared schema + 类型：先用 Zod 固化多 hunk 契约，并补 schema 往返测试。
2. Agent diff 生成器 + 单元测试：单段、多段、相邻合并、文件头尾、CRLF、replace_all、超限截断。
3. Agent 工具输出：`EditOutput.diff`、`exposeOutput`、`toModelOutput`；补 registry 测试证明模型文本不变、其他工具仍返回字符串。
4. UI 渲染：先接结构化 `diff.hunks`，保留字符串/旧结构化对象的 fallback；再补多 hunk 无间隔/有间隔、行号、截断和 CSS 守卫。
5. 实机验证：在一个文件里做相距很远的两次替换、`replace_all` 三次替换、文件头/文件尾替换，逐步比对展开卡。

## 模块边界

- `packages/shared/src/schema/toolDisplay.ts`：只有展示数据 schema/类型；不含 diff 算法、React、Agent 运行时。
- `apps/agent/src/core/tool/builtin/editDisplayDiff.ts`：纯函数，只接收规范化前后的文件文本；不读写文件、不创建事件、不依赖 UI。
- `apps/agent/src/core/tool/builtin/edit.ts`：只把写入成功后的完整前后文本交给 diff 生成器，并把结果放进 `EditOutput`；不格式化 UI 文本。
- `apps/agent/src/core/tool/registry.ts`：只负责 `exposeOutput` 与 `toModelOutput` 的通用协议适配；不为 Edit 写特判。
- `apps/agent/src/core/tool/contracts.ts`：只增加通用“是否把 handler output 暴露到事件”的布尔契约，不认识 Edit 字段。
- `packages/ui/src/components/tool-call/renderers/edit.tsx`：只做 output 收窄、hunk 投影和 DOM；shared hunk 的行号投影在 `editDisplay.ts`，旧格式兼容 diff 在 `editDiff.ts`。
- `packages/shared/src/schema/events.ts`：`output` 继续是 `unknown`；不新增事件 kind，不把 UI 展示结构写进 envelope。
- 不把完整文件内容放入事件；事件只携带裁剪后的 hunks 和统计。

## 曾考虑的替代方案

- **只在 UI 里给 `old_string/new_string` 补上下文：** 舍弃。UI 没有文件原文，补出来的是假上下文；也无法知道 `replace_all` 的其它命中位置。
- **UI 通过 IPC 读取工作区文件再算 diff：** 舍弃。renderer 会获得文件读取权限，且读取时文件可能已被后续编辑改变；这违反 Agent 工具由 Agent 进程执行、UI 不代执行的边界。
- **把 patch 放进 `formatModelContent` 让 UI 解析：** 舍弃。模型会看到与任务无关的 patch，上下文预算被污染；UI 还要维护第二套 unified diff 解析器。
- **直接引入 `@pierre/diffs` / Shiki：** 舍弃。完整 diff 面板需要 worker、Shadow DOM 和语法高亮，适合侧边文件视图；消息流只需要轻量 hunk，引入会放大首帧和依赖成本。
- **每个 hunk 单独一张卡片：** 舍弃。会重复文件名、统计和复制按钮，长 diff 变成多张卡；参考 UI 是一个连续卡片，用间隔行表达未显示区间。
- **把 `output` 直接改成固定 Edit 类型：** 舍弃。`tool-execution-finished` 服务所有工具，不能为一个工具改共享 schema；用 `exposeOutput` 只影响该工具的 output，事件 envelope 保持 `unknown`。
- **继续只做单 hunk 并显示 `N 处替换`：** 舍弃。用户需要看到每一次真实变更及其上下文，单 hunk 无法表达 `replace_all` 的多个位置。

## 后果与防回退

- `tool-execution-finished.result.output` 对 Edit 变为结构化对象，其他工具仍是字符串；新增消费方必须同时兼容两种形态。
- UI 必须保留 `old_string/new_string` fallback，旧 transcript 事件没有结构化 diff 时不能白屏。
- hunk 行号必须来自完整文件的实际行号；不能用 hunk 内数组下标冒充。
- diff 预算只影响展示，不得阻断磁盘写入；超限必须显式标记 `truncated`。
- 多段复制仍只复制 `new_string`，不是完整 patch；不能把该行为写成“复制完整 diff”。

## 验证

- 已由自动化覆盖：
  - 单处替换显示变更行及前后各 3 行原文，行号为真实文件行号。
  - `replace_all` 命中多个位置时生成多个 hunk；远处 hunk 之间有 `⋯ N 行未修改`，相邻 hunk 按 6 行阈值合并。
  - 文件头/文件尾替换不越界，不出现 `0` 或负数行号。
  - 旧事件没有结构化 diff 时仍能显示变更行（无上下文降级），不崩溃。
  - shared schema 往返、空 hunks 与非法 hunk 拒绝。
  - Agent 生成器覆盖单段、多段、合并、CRLF、插入、文件尾、replace_all、hunk/行数上限。
  - registry 覆盖 Edit 返回结构化 output、`toModelOutput` 模型文本不变、普通工具仍返回字符串。
  - UI 覆盖多 hunk 行号、段间分隔、单段无分隔、截断提示、malformed / legacy fallback、sticky 行号 CSS 守卫。
- 仍需实机验证：
  - 在 Windows Electron 下展开一个 3 段 diff，确认横向滚动时行号 sticky、段间分隔和红绿底色与参考图一致。
  - 修改 Agent 后必须重启 `pnpm dev:full`；只重载 renderer HMR 不会更新工具输出。

## 风险

- 全文件 diff 在极端大文件/大量替换时仍有计算成本；必须用公共前后缀、LCS 上限、hunk 数和行数上限兜底，超限时明确显示截断。
- hunk 行号与文件真实行号一旦错位会直接误导用户；必须用完整文件行号生成，不能用 hunk 内数组下标。
- `exposeOutput` 改变 Edit 的事件 output 类型；若其他消费方（未来的持久化、CLI）仍假定 output 是字符串，需要同步适配。其他工具不受影响。
- 旧 transcript 事件可能只有字符串 output；fallback 必须保留，且测试不能只覆盖新格式。
- 多段复制语义本期仍复制 `new_string`，不是完整 patch；这是有意的范围限制，不能把它误写成“复制完整 diff”。
