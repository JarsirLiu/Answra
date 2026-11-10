# Note：工作区 Edit 工具（精确字符串替换）

状态：已实施

## 问题

`general-chat` 目前只授权 `Read`、`Grep`、`RunCommand`、`WriteStdin`。模型要修改文件时只能通过 shell 重定向或脚本落盘，缺少以下约束：

- 没有 read-before-edit：模型可以在没有读取原文的情况下覆盖文件；
- 没有并发修改检测：用户或其他程序在读取后改动文件时，模型仍会写回旧内容；
- 没有结构化差异：用户只能从 shell 输出猜测改了什么；
- 没有写回后的状态更新：下一次 `Read` 可能仍返回 `file_unchanged`。

本提案新增专用 `Edit` 工具，只做“在已读文件中精确替换一段文本”。核心目标不是让模型“尽量改成功”，而是让错误输入明确失败，让成功写入可验证、可回填、可继续读取。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/tool/builtin/edit.ts`（新增）：`Edit` 工具契约、输入 schema、handler、模型可见结果。
  - `apps/agent/src/core/tool/builtin/editMatch.ts`（新增）：纯匹配与替换算法。
  - `apps/agent/src/core/tool/builtin/readFileState.ts`（新增）：会话级读取状态键、可编辑视图判定、编辑后刷新。
  - `apps/agent/src/core/tool/contracts.ts`：`ReadFileStateEntry` 增加 `origin: "read" | "edit"`。
  - `apps/agent/src/core/tool/builtin/read.ts`：改为复用 `readFileState.ts`，行为不变。
  - `apps/agent/src/core/tool/builtin/workspace.ts`：补充写目标解析、编码/BOM/行尾保留、原子写入。
  - `apps/agent/src/core/tool/builtin/index.ts`：注册 `workspace.edit`。
  - `apps/agent/src/conversation/profiles/registry.ts`：只给 `general-chat` 授权 `workspace.edit`，并补充“改文件前先 Read”的提示。
  - `apps/agent/src/core/tool/builtin/editDisplayDiff.ts`：从完整 before/after 生成有界多 hunk。
  - `packages/shared/src/schema/toolDisplay.ts`：多 hunk 展示契约。
  - `packages/ui/src/components/tool-call/renderers/edit.tsx`（新增）：摘要、多 hunk diff、复制与失败文本。
  - `packages/ui/src/components/tool-call/renderers/editDisplay.ts`：shared hunk 到 UI 行号的投影。
  - `packages/ui/src/components/tool-call/renderers/editDiff.ts`（新增）：只基于 `old_string`/`new_string` 的单段兼容 diff。
  - `packages/ui/src/components/tool-call/renderers/edit.module.css`（新增）：diff 面板、文件名、增删统计、sticky 行号与 hunk 间隔样式。
  - `packages/ui/src/components/tool-call/resolveToolCallRenderer.tsx`：把 wire name `Edit` 映射到新 renderer。
- 测试：
  - `apps/agent/test/core/tool/edit.test.ts`（新增）
  - `apps/agent/test/core/tool/editMatch.test.ts`（新增）
  - `apps/agent/test/core/tool/editDisplayDiff.test.ts`（新增）
  - `apps/agent/test/core/tool/readFileState.test.ts`（新增）
  - `apps/agent/test/core/tool/workspace.test.ts`、`builtinTools.test.ts`（扩展）
  - `apps/agent/test/core/tool/registry.test.ts`（`exposeOutput` / `toModelOutput`）
  - `apps/agent/test/conversation/application.test.ts`（授权 schema 断言）
  - `packages/shared/test/schema.test.ts`（多 hunk 契约）
  - `packages/ui/test/editDiff.test.ts`（新增）
  - `packages/ui/test/toolCallRenderers.test.tsx`（扩展）
- UI/进程/协议/持久化表面：
  - 不新增 IPC 频道、不修改 worker 线协议、不修改 `packages/shared/src/schema/`。
  - 复用既有 `tool-execution-started` / `tool-execution-finished` / `tool-output-delta`。
  - 不新增审批事件或审批 UI；既有 `tool-approval-request` 与 `awaiting-approval`/`denied` 状态词汇保持现状，不被 Edit 使用。
- 相关 Note：
  - `../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md`
  - `../../implemented/feature/2026-10-26-workspace-agent-read-tools.md`
  - `../../implemented/feature/2026-11-09-read-tool-text-quality.md`
  - `../../implemented/architecture/2026-11-09-workspace-default-root-not-boundary.md`
  - `../../implemented/architecture/2026-11-09-tool-call-ui-architecture.md`
  - `../../implemented/architecture/2026-11-09-tool-business-failures-as-model-results.md`

## 决定

### 1. 工具契约

输入固定为四个字段：

```ts
interface EditInput {
  file_path: string;     // 绝对路径优先；也接受工作区相对路径
  old_string: string;    // 要替换的原文，必须精确、唯一
  new_string: string;    // 替换结果，允许空字符串以删除文本
  replace_all?: boolean; // 默认 false；为 true 时替换所有匹配
}
```

- `ToolId`：`workspace.edit`；wire name：`Edit`。
- `metadata`：`readOnly: false`、`destructive: false`、`concurrentSafe: false`、`sideEffectScope: "workspace"`、`timeoutMs: 30_000`。
- `maxOutputBytes` 与 `resultBudget.maxModelChars`：20_000。模型结果只返回短回执，不返回整个文件或完整 diff。
- `inputSchema` 使用 `JSONSchema7`，不引入 zod。
- `validateInput` 只补 schema 无法表达的跨字段约束：
  - `old_string` 为空：拒绝。本期不支持新建文件，新建留给后续 `Write` 工具。
  - `old_string === new_string`：拒绝，避免无意义写盘。
  - `replace_all` 必须是布尔值。
- 单文件上限 1 MiB；超过时明确失败，不截断后编辑。

### 2. 防乱写：前置条件

Edit 必须先证明“模型看过这个文件，而且文件没变”：

1. 解析目标路径并 `realpath`，继续排除 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl` 目录。
2. 目标必须是已存在的普通文件；不新建、不跟随目录、不删除。
3. `readFileState` 必须存在。缺失时 fail-closed，返回“当前会话没有文件读取状态，不能编辑”。不允许因为状态缺失就跳过校验。
4. 在 `readFileState` 中查找该路径最近一次读取记录：
   - 找不到：失败，提示先 `Read`。
   - 只有 `partialView` 记录：失败，提示先完整读取或改用更小的读取范围后重新读取。
   - 找到非 partial 记录：继续。
5. 读取当前文件并比较 `mtimeMs` 与 `sizeBytes`：
   - 与读取记录不一致：失败，提示文件已被修改，需要重新 `Read`。
   - 一致：继续。
6. 只允许编辑 UTF-8、UTF-8 BOM、UTF-16LE、UTF-16BE 文本；其他编码明确失败，不做有损转换。

### 3. 防乱写：匹配规则

匹配必须可解释、可复现，不做模糊猜测：

1. 文件内容和 `old_string` 都先把 CRLF 归一为 LF 再匹配。
2. 先做精确 `indexOf`。
3. 精确匹配为零时，才尝试剥离 Read 输出前缀：如果 `old_string` 的每一行都以 `行号\t` 或 `行号: ` 开头，剥离后再匹配一次。
4. 统计命中次数：
   - 0 次：失败，返回“原文未找到”，并提示重新读取或缩小替换范围。
   - 1 次：允许替换。
   - 多次且 `replace_all=false`：失败，返回命中次数，要求提供更多上下文或显式设置 `replace_all`。
   - 多次且 `replace_all=true`：全部替换。
5. 使用函数式替换写回，避免 `$&`、`$$`、`$1` 被 `String.replace` 当成特殊 token。
6. 不做大小写忽略、空白折叠、缩进猜测、引号归一或相似度匹配。匹配失败必须让模型重新读取，而不是让工具猜。

### 4. 防乱写：并发与写入

- 写前再次 `stat`，与读取记录比较；`mtimeMs` 或 `sizeBytes` 变化即失败，删除临时文件，不覆盖原文件。
- 替换后内容与原文相同（包括剥离 Read 行号前缀后才相等的情况）时拒绝写盘。
- 编码后的字节数超过 1 MiB 时拒绝写盘，不截断。
- 使用同目录临时文件写入，`fsync` 后 `rename` 覆盖目标：
  - 临时文件写入或 `rename` 失败：清理临时文件，返回可恢复失败，原文件保持完整。
  - 写回结果的 `mtimeMs` / `sizeBytes` 取自 `rename` 前的临时文件 `stat`，避免 `rename` 成功后再次 `stat` 失败导致“文件已改但工具报错”。
  - 不提供“rename 失败就退回直接覆盖”的降级路径，避免半写或损坏。
- 保留源文件编码、BOM 与行尾风格：
  - 原文是 CRLF，写回统一转成 CRLF；
  - 原文有 UTF-8 BOM，写回保留 BOM；
  - UTF-16LE/BE 按原编码写回；
  - 保留原文件权限位。
- 符号链接按 `realpath` 后的目标写入，链接本身不被替换。
- 每次写盘前后检查 `AbortSignal`；取消后不再继续写入。
- 业务失败返回 `ToolHandlerFailure`，由执行器投影为模型可见文本；只有磁盘/进程异常继续抛出。

### 5. 写完结果回填

写入成功后必须回填两类状态：会话读取状态、模型与 UI 回执。

**会话读取状态**

1. 删除 `readFileState` 中该路径所有旧的范围缓存。
2. 写入一条新的整文件基线：
   - `path`：真实路径；
   - `mtimeMs` / `sizeBytes`：`rename` 前临时文件的 `stat`（`rename` 保留该时间戳）；
   - `offset: 1`、`limit: undefined`；
   - `partialView: false`；
   - `origin: "edit"`。
3. `origin: "edit"` 允许模型连续编辑，不必为第二次编辑强制 Read。
4. `Read` 的未变化缓存只接受 `origin: "read"`，因此下一次 `Read` 会返回新内容，而不是 `file_unchanged`。

**工具输出与回执**

`Edit` handler 返回结构化结果：

```ts
interface EditOutput {
  type: "edited";
  filePath: string;
  replacements: number;
  replaceAll: boolean;
  lineEndings: "LF" | "CRLF";
  sizeBytes: number;
  diff: EditDiffDisplay;
}
```

- `formatModelContent` 只输出短回执：
  - 成功：`The file <path> has been updated successfully.`，`replace_all` 时补充“所有匹配均已替换”，并说明无需再次 Read 校验。
  - 失败：沿用 `工具调用失败（<code>）：<message>`，附上下一步动作。
- 事件层沿用 `tool-execution-started` / `tool-execution-finished`，不新增事件类型。
- `ToolEntry` 增加通用 `exposeOutput`；仅 Edit 开启，成功时 `registry.createModelTool().execute` 返回结构化 `EditOutput`，UI 可读取 `part.output.diff`。AI SDK 6 `toModelOutput` 用 `formatModelContent` 保证模型看到的仍是短回执；其他工具和失败结果继续返回字符串。多 hunk 细节见 [Edit 多 hunk diff 展示](../architecture/2026-11-10-edit-multi-hunk-diff-display.md)。
- 文件系统 watcher 若已监听工作区，会自然触发目录树/预览刷新；本期不新增 IPC，也不把刷新作为 Edit 的成功条件。

### 6. 事件、状态与 UI 接入

不需要修改状态机或事件 schema：

- `executeRun.ts` 的 `experimental_onToolCallStart/Finish` 已按通用工具名写入 `tool-execution-started/finished`。
- `ExecutionStore` / `MemoryExecutionStore` 只按 envelope 追加，不认识具体工具。
- `conversationParts.ts` 已把工具事件映射为 `pending -> running -> completed/failed`。
- UI 只需增加 `Edit` renderer，并在 `resolveToolCallRenderer` 注册；未知工具仍走 fallback。

审批目前只有状态词汇和事件 schema，没有执行链路：`tool-approval-request` 已定义，`awaiting-approval`/`denied` 已有投影，但 `ToolMetadata` 没有 `needsApproval`，registry 不设置 AI SDK 审批，worker 协议没有审批响应命令，desktop/UI 没有批准入口。因此 Edit v1 不产生审批事件，也不会卡在 `awaiting-approval`。

### 7. 授权与提示

- 只加入 `general-chat` profile 的 `tools`；`answer` 和 `interview` 不授权。
- `general-chat` 的 system prompt 增加一句：修改文件前先用 `Read` 查看原文，不要用 shell 覆盖整个文件。
- 工作区仍只是默认根，不是访问边界；Edit 与 Read 使用同一套路径解析和 VCS 排除规则。

## 影响表面

- 用户可在普通对话中让模型修改工作区文本文件；修改前必须已经通过 `Read` 看过该文件，否则明确失败。
- 模型能删除文本范围（`new_string` 为空），但不能新建文件、重命名或删除文件；这些能力留给后续独立工具。
- UI 工具卡新增 `Edit`：摘要是文件名；展开为多 hunk 行级 diff，带文件名、`+N -M`、复制修改后片段、每个 hunk 前后各 3 行真实文件上下文、hunk 间未修改行数，以及失败原因与“未写入文件”提示。结构化 `diff` 缺失时回退到 `old_string`/`new_string` 的单段兼容展示。
- 用户仍是最终风险承担者：本期没有逐次审批，模型在获得授权的 profile 内可直接写入。

## 曾考虑的替代方案

- **只做 `Write` 整文件覆盖：** 舍弃。整文件覆盖会让模型重写未读内容，且更容易在长文件中丢行；精确替换的 diff 更小、更可审计。
- **把 Edit 放进 shell 用脚本完成：** 舍弃。无法获得读取状态、并发检测和结构化差异，失败也不可预测。
- **本期同时实现审批链路：** 舍弃。需要新增 worker 命令、desktop IPC、UI 审批按钮和超时状态，属于跨进程协议变更；当前 `RunCommand` 也没有审批。先把工具正确性做好，审批单独提案。
- **引入模糊匹配（引号归一、缩进弹性、块锚点）：** 舍弃。宽匹配可能在模型抄错缩进时改到相邻代码；本期先用精确匹配和 Read 行号前缀剥离覆盖高频错误，出现真实样本后再加。
- **维持所有工具只返回字符串：** 舍弃。多 hunk 展示需要结构化输出；后续在 `ToolEntry` 增加通用 `exposeOutput`，仅 Edit 开启，并用 AI SDK 6 `toModelOutput` 保持模型文本不变。没有为 Read/Grep 一并改造，避免扩大第一版范围。
- **在同一个工具里同时支持 create/update/delete/move：** 舍弃。第一版把“编辑已存在文件”做扎实；多操作补丁工具需要独立的输入协议、删除确认和移动冲突处理。
- **把 Edit 授权给答题和面试：** 舍弃。答题是截图问答，面试是语音转写，没有文件编辑语义；扩大授权只会增加不可见写入风险。

## 验收结果

- 未 Read 直接 Edit：失败并提示先 Read；`readFileState` 缺失时 fail-closed；只有 partial view 时拒绝。
- Read 后文件被外部修改再 Edit：失败并提示重新 Read，原文件不变。
- 唯一匹配：文件内容正确替换；UTF-8 BOM、UTF-16LE/BE、CRLF 与权限位保持不变。
- 多处匹配且 `replace_all=false`：失败并报告次数；`replace_all=true` 时全部替换。
- `old_string` 带 Read 行号前缀：可正确匹配；剥离后替换结果与原文相同时拒绝无意义写盘。
- 成功写入后再次 Read：返回新内容，不返回 `file_unchanged`；连续 Edit 可直接基于编辑后的基线继续。
- 写入内容超过 1 MiB：拒绝写盘，原文件与临时文件清理正常。
- UI 显示 `Edit` 卡片、文件名、`+N -M`、多 hunk 行级 diff、`replace_all` 替换次数与失败原因；每个 hunk 显示真实旧/新文件行号与前后上下文，远隔 hunk 之间显示未修改行数；复制按钮复制修改后的片段；失败时显示“编辑未写入文件”；畸形输入回退到通用展示。
- 结构化 `diff` 缺失或解析失败时回退到 `old_string`/`new_string` 单段展示；旧事件不白屏。
- 尚未完成实机验证：桌面端真实模型 Read → Edit → 再 Read，以及外部编辑器修改后的 stale 提示。

## 后果与防回退

- 正面后果：模型有专用、可解释的文件修改路径；未读、文件已变、匹配歧义、无意义写盘和超限写入都会明确失败，不再依赖 shell 重定向。
- 代价：本期没有逐次审批，`general-chat` 内模型可直接写入；风险由 profile 授权和用户可见工具卡承担。
- 代价：只支持精确匹配和 Read 行号前缀剥离，模型抄错缩进或空白时会失败重试，不做猜测性修改。
- 代价：编码保留仅覆盖 UTF-8/UTF-16，其他编码继续拒绝；Windows 上原子写可能受占位文件或杀软影响，失败时不降级为直接覆盖。
- 防回退：
  - 不得在缺少完整 Read 基线时允许 Edit；`readFileState` 缺失必须 fail-closed。
  - 不得移除写前 `mtimeMs` / `sizeBytes` 比较，也不得在 `rename` 失败后降级为直接覆盖。
  - 不得让 `origin: "edit"` 的基线阻止下一次 Read 读取新内容。
  - 不得把精确匹配改成模糊匹配或忽略空白；匹配失败必须让模型重新 Read。
  - 不得静默截断超限文件或超限写回内容。
  - Edit 的 `part.output` 是结构化对象，模型可见文本由 `toModelOutput` 单独生成；UI diff 来自结构化 `diff`，旧事件才回退 `part.input`。结构化输出不能替代文件系统事实。
  - 不得把 UI diff 描述成整个文件的完整 diff；它是完整文件中的上下文 hunk，远端未显示区间必须保留 gap 提示。
  - 不得再用 hunk 内数组下标或片段内序号冒充真实文件行号；只有旧格式 fallback 才按片段起点显示。
  - 不得在 diff 计算中无界展开完整文件或 `old_string`/`new_string`；当前用 LCS 上限、最多 20 段 / 600 行 / 20k 字符兜底，并明确提示截断。

## 验证

- shared：`schema.test.ts` 11 项通过，覆盖多 hunk 往返、空 hunks 与非法 hunk 拒绝。
- Agent targeted：`editDisplayDiff.test.ts` 8 项、`edit.test.ts` 15 项、`registry.test.ts` 7 项，共 30 项通过。
- UI targeted：`editDiff.test.ts` 5 项、`toolCallRenderers.test.tsx` 23 项、`themeCss.test.ts` 17 项，共 45 项通过；UI 全量 36 个文件、294 项通过。
- `pnpm typecheck`（shared / agent / ui / desktop）、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check`：通过。
- `pnpm verify` 当前未全绿：本轮并行负载下 VAD segmenter 1 例 5 秒超时，`shell/sessions.test.ts` 6 例、`shell/shellTools.test.ts` 3 例失败；随后单独重跑 VAD 通过，shell 仅剩 `removes the PowerShell script echo and location block from session stderr` 仍返回 `running`。该用例不经过 Edit diff 链路，需在 shell 相关变更中单独确认。
- 实机验证待补录：桌面端普通对话中的 Read → Edit → 再 Read，以及外部修改后的 stale 失败提示；3 段 diff 的 sticky 行号与段间分隔也需在 Windows Electron 下目检。
