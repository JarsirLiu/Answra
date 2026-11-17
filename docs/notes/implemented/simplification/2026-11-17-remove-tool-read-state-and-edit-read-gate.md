# Note：移除工具读前状态，Edit 改为自读与单路径串行

状态：已实施

2026-11-17 已按第一刀落地：删除会话级读取状态，`Edit` 自读并按路径串行，`Read` 不再返回 `file_unchanged`；`RunCommand`、shell 会话和进程树未改。全量验证期间额外补了 Windows `rename` 共享冲突的短退避重试。

## 问题

旧实现中 `Read` 与 `Edit` 通过会话级 `ReadFileStateMap` 绑定：`Read` 写读取记录，`Edit` 必须找到一条非 `partialView` 的最新记录，再比较 mtime/size 或内容 hash，才允许写盘。

这套状态同时承担了缓存、编辑门禁、并发校验和写后回填四种职责，并穿过 `conversation`、`coding`、`interview` 三个领域：

- `Read` 只有 token 截断时把 `partialView` 设为 `true`；`offset`/`limit` 范围读取仍被当成完整编辑基线（`apps/agent/src/core/tool/builtin/read/tool.ts`、`apps/agent/src/core/tool/state/readFileState.ts`）。
- `Edit` 写回 CRLF 文件后，用内存中的 LF 文本记录 hash；下一次编辑读取 CRLF 文本时 hash 不一致，误报“文件已被修改”（`apps/agent/src/core/tool/builtin/edit/tool.ts`、`apps/agent/src/core/tool/builtin/edit/match.ts`、`apps/agent/src/core/tool/workspace/atomicWrite.ts`）。
- 每次新增读取形式或写回规则，都要同时维护 key、`partialView`、`origin`、mtime/size/hash 和三个领域的接线，边界组合持续增长。

用户已明确要求向 pi 的简单模型收敛：文件工具不维护跨调用读取状态，`Edit` 自己读文件并按精确匹配写入；保留 `RunCommand` 和交互会话，本轮只处理文件工具这一刀。

## 涉及范围

- 工具契约与状态：
  - `apps/agent/src/core/tool/contracts.ts`
  - `apps/agent/src/core/tool/registry.ts`
  - `apps/agent/src/core/tool/index.ts`
  - `apps/agent/src/core/tool/state/readFileState.ts`（删除）
- 文件工具：
  - `apps/agent/src/core/tool/builtin/read/tool.ts`
  - `apps/agent/src/core/tool/builtin/read/output.ts`
  - `apps/agent/src/core/tool/builtin/edit/tool.ts`
  - `apps/agent/src/core/tool/builtin/edit/match.ts`
  - `apps/agent/src/core/tool/builtin/edit/mutationQueue.ts`（新增）
  - `apps/agent/src/core/tool/workspace/atomicWrite.ts`
- 领域接线：
  - `apps/agent/src/conversation/application.ts`
  - `apps/agent/src/conversation/agent.ts`
  - `apps/agent/src/coding/application.ts`
  - `apps/agent/src/coding/agent.ts`
  - `apps/agent/src/interview/application.ts`
  - `apps/agent/src/interview/agent.ts`
  - `apps/agent/src/coding/policy.ts`
  - `apps/agent/src/conversation/profiles/registry.ts`
- UI：
  - `packages/ui/src/tool-presentation/tools/read.ts`
  - `packages/ui/test/toolPresentation.test.ts`
- 测试：
  - `apps/agent/test/core/tool/edit.test.ts`
  - `apps/agent/test/core/tool/read.test.ts`
  - `apps/agent/test/core/tool/readOutput.test.ts`
  - `apps/agent/test/core/tool/builtinTools.test.ts`
  - `apps/agent/test/core/tool/workspace.test.ts`
  - `apps/agent/test/core/tool/readFileState.test.ts`（删除）
  - 三个领域应用的既有测试按类型变化调整
- UI/进程/协议/持久化表面：
  - 不新增 IPC、worker 消息或持久化字段。
  - 模型可见行为变化：`Edit` 不再要求先 `Read`；重复 `Read` 不再返回 `file_unchanged`。
  - Read 工具卡不再显示 “Unchanged since last read”。
- 相关 Note：
  - `../feature/2026-11-10-workspace-edit-tool.md`
  - `../feature/2026-11-09-read-tool-text-quality.md`
  - `../feature/2026-11-10-read-tool-document-text.md`
  - `../feature/2026-11-16-workspace-edit-create-file.md`
  - `../feature/2026-11-16-agent-tool-cross-platform-shell-and-edit-state.md`
  - `../architecture/2026-11-09-agent-tool-system-foundation.md`
  - `../architecture/2026-11-16-tool-runtime-directory-decomposition.md`
  - `../../proposed/architecture/2026-11-16-tool-runtime-portability-and-directory-contract.md`

本决定取代上述 Note 中“Edit 必须持有完整 Read 基线”和“重复 Read 返回 `file_unchanged`”的约束，并已同步改写这些 Note 的现状与防回退条目。

## 决定

### 1. 删除跨调用读取状态

会话不再保存文件读取记录：

- 删除 `ReadFileStateEntry`、`ReadFileStateMap`、`createReadFileStateKey`、`findReadFileStateForEdit`、`matchesFileStat`、`hashReadFileContent`、`recordEditedFileState`、`clearReadFileStatesForPath`。
- 从 `ToolContext`、`ToolSessionContext`、`ToolRegistry.authorize` 和三个领域的 Agent 输入中删除 `readFileState`。
- 删除 `conversation`、`coding`、`interview` 三处的 `readFileStates` Map、`getReadFileState` 和清理逻辑。
- `Read` 不再读写状态；`Edit` 不再读取状态、写后回填或维护 `origin`。

状态归属变为：`Read` 完全无状态；`Edit` 只在单次调用内持有刚读取的文本和 stat；并发控制由 Edit 模块内的按路径队列负责。

### 2. Edit 自己读文件

`Edit` 的输入和输出契约保持不变，执行顺序改为：

1. 解析目标路径；创建模式仍要求目标不存在。
2. 编辑模式直接读取当前文件，不检查任何历史 Read 记录。
3. 按现有规则做精确匹配；多处匹配且 `replace_all=false` 时仍失败。
4. 用本次读取得到的 `mtimeMs`/`sizeBytes` 做写前校验，然后原子写回。
5. 返回现有 `edited`/`created` 结构化结果和 diff。

这样保留单次调用内的并发保护，但不再把保护扩展成跨调用的会话状态。`old_string` 精确匹配仍是主要正确性来源；文件在本次读取后被外部改动时，写前 stat 校验会失败。

`fillExistingEmptyFile` 也改为自己读取并确认内容为空后写入，不再要求调用方先 `Read`。创建新文件和空文件回填的编码/BOM/行尾/权限保留逻辑不变。

### 3. 按路径串行写操作

在 Edit 模块增加一个按路径排队的 `withEditMutationQueue`（`builtin/edit/mutationQueue.ts`）：

- 按 `path.resolve` 后的目标路径排队；Windows 使用小写 key，避免大小写不同导致同一文件并发。
- 同一路径的读取、匹配、写回整体串行，避免两个并发 Edit 交错读写。
- 队列只覆盖进行中的写操作，完成后删除对应 key；不做全局调度器，也不消费未实现的 `concurrentSafe` metadata。
- 不同路径不互相阻塞。

该队列替代原 `ReadFileStateMap` 的并发职责，但不承担缓存或编辑门禁。

### 4. Read 不再返回 file_unchanged

`Read` 保留 `file_path`、`offset`、`limit`、token 截断提示、文档抽取和行号输出，但删除：

- 缓存查找和 `file_unchanged` 返回。
- `ReadUnchangedOutput` 与 `FILE_UNCHANGED_STUB`。
- UI 对 `file_unchanged` 的展示分支和对应测试。
- `Read` 对 `readFileState` 的依赖。

重复读取同一范围会再次返回文本。提示词仍建议模型不要为了“验证编辑”重复读取，但不再由工具层用状态替模型判断。

### 5. 提示词与错误文案

- `Edit` 工具描述从“必须先完整 Read”改为“编辑前建议先 Read；精确匹配是写入前提”。
- `coding` prompt 的“修改现有文件前必须先用 Read”改为“优先 Read 确认原文”，不把 Read 作为工具硬门禁。
- `conversation` 的同类提示同步调整。
- `atomicWrite` 的“目标文件已存在，请先 Read 后再写入”改为“目标文件已存在，不能用空 old_string 覆盖”。

### 6. Windows 原子替换的短退避重试

全量测试暴露了 Windows 上 `fs.rename` 覆盖目标时偶发 `EPERM`：文件刚由测试或外部工具关闭，杀毒/索引器仍可能短暂持有目标。`atomicWrite` 只在 `win32` 对 `EPERM`/`EACCES`/`EBUSY` 做 5 次短退避（10/20/40/80/160ms），每次重试前重新 `stat` 并校验读取基线；非 Windows 或非共享冲突立即失败。

保留原子写，不降级为“删除目标后 rename”或直接覆盖；重试只吸收短暂共享冲突，不掩盖真实权限错误。

### 7. 明确不做

- 不改 `RunCommand`、`shell/runtime.ts`、`sessions.ts`、`sessionContract.ts`、`processTree.ts`；shell 统一留到第二刀。
- 不新增 `Write`、`Glob`、`WriteStdin`。
- 不删除 `Edit` 的创建模式，也不恢复 shell 整文件覆盖。
- 不新增权限、沙箱、审批或通用工具并发策略。
- 不迁移测试目录，不做无关格式化。
- 不清理未消费的 `readOnly`/`destructive`/`sideEffectScope` metadata；如需清理单独提案，避免和读取行为变化混在一起。

## 移除内容

- `apps/agent/src/core/tool/state/readFileState.ts` 及其测试。
- `ReadFileStateEntry`、`ReadFileStateMap`、`readFileState` 在工具契约、注册表、Agent 输入和三个领域应用中的全部接线。
- `partialView`、`origin`、`contentHash`、mtime/size 跨调用基线，以及 `file_unchanged` 输出。
- `Read` 的缓存查询与状态写入；`Edit` 的读前查询、写后回填和重复编辑基线。
- `Edit` 的“没有读取记录不能编辑”失败分支。
- UI 的 “Unchanged since last read” 投影和测试。

保留：

- `Edit` 的精确匹配、`replace_all`、行号前缀剥离、创建模式、空文件回填、结构化 diff。
- 单次 Edit 内的写前 `mtimeMs`/`sizeBytes` 校验和原子写。
- Read 的 offset/limit、token 预算、UTF-8/UTF-16 和文档抽取。

## 重新引入条件

- 只有在真实使用中出现“重复 Read 造成明显上下文浪费”的测量证据时，才考虑读取缓存；缓存不得再作为 Edit 门禁，且应独立于工具契约。
- 只有在出现可复现的盲编辑事故时，才考虑重新引入读前门禁；优先用提示词、工具描述和测试修正，不恢复跨领域状态。
- 如果外部并发写入造成真实丢更新，在单次 Edit 内增加乐观并发校验，而不是恢复会话级读取基线。
- 如果需要跨文件事务或批量原子写，单独提案，不把事务状态塞回 Read。

## 曾考虑的替代方案

- **保留读前状态，只修 `partialView` 和 CRLF hash：** 舍弃。只是继续给状态机打补丁，仍要维护 key、范围、origin、hash 和三层接线；下一次读取形式变化还会产生同类边界。
- **只保留 `file_unchanged` 缓存，把 Edit 从状态中解耦：** 舍弃。跨领域接线仍然存在，而缓存收益没有测量证据；真需要时再做独立、非门禁的读取缓存。
- **每次 Edit 重算完整文件 hash，替代 mtime/size：** 舍弃。仍会引入“读取基线”和 false conflict 语义；精确匹配加单次调用内 stat 已经覆盖主要写入安全。
- **完全照 pi 直接写文件，不做原子写和 stat 校验：** 舍弃。原子写和单次 stat 校验成本低，却能避免半写和明显的外部改动覆盖；保留它们不需要跨调用状态。
- **新增独立 `Write` 工具：** 舍弃。用户已决定 `Edit` 兼顾新建，新增工具会扩大模型选择面。
- **增加通用工具并发调度器：** 舍弃。当前只有 Edit 需要按路径串行，一个小队列足够；通用调度属于未证实需求。
- **给范围读取补一个“是否覆盖全文”字段，仍保留读前门禁：** 舍弃。能修当前漏洞，但保留整套状态和三层接线，和本轮简化目标相反。

## 验收结果

- 未先 `Read` 直接 `Edit` 成功，只要 `old_string` 精确匹配。
- 先 `Read` 一个范围再 `Edit`，不再因为“只有 partial view”被拒绝。
- 连续编辑 CRLF 文件两次，第二次不再因 hash/行尾不一致误报“文件已修改”。
- 同一路径两个并发 `Edit` 串行执行，最终内容包含两次替换，没有交错或半写。
- 重复 `Read` 返回文本内容，不再返回 `file_unchanged`。
- 新建文件、空文件回填、`replace_all`、唯一匹配失败和 diff 展示行为不变。
- `RunCommand`、shell 会话和进程树行为不变。
- Windows `EPERM` 共享冲突可由短退避重试吸收；非共享冲突仍失败，不降级为直接覆盖（`workspace.test.ts` 新增回归用例）。

## 后果与防回退

- 正面后果：工具契约不再有跨领域读取状态；`partialView` 误判和 CRLF hash 假冲突从根上消失；Read/Edit 的职责和失败原因更少。
- 代价：重复 Read 会重新消耗上下文；外部修改只靠本次 Edit 的精确匹配和写前 stat，不再有跨调用 hash/mtime 基线。
- 代价：Windows 上最多增加约 310ms 的短暂重试延迟；这是吸收杀毒/索引器共享冲突的成本，不是常规路径。
- 防回退：
  - 不得恢复会话级 `ReadFileStateMap`、`readFileState` 注入、完整 Read 基线门禁或 `file_unchanged`。
  - 不得移除 `Edit` 自读、单次调用内 `mtimeMs`/`sizeBytes` 校验、原子写和按路径队列。
  - 不得把 Windows `rename` 重试降级为“删除目标后 rename”或直接覆盖；重试只限共享冲突。
  - 队列完成后必须删除 key；不同路径不得互相阻塞。
  - 不得把 shell 统一、`RunCommand` 或交互会话混入本决定；第二刀需单独提案。
  - `Read` 只保留 offset/limit、token 预算和截断提示，不得重新承担编辑门禁或缓存职责。

## 验证

- `pnpm --filter @answra/agent test`：78 个文件、576 项通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/workspace.test.ts test/core/tool/edit.test.ts`：36 项通过（含 Windows rename 重试与队列失败释放）。
- `pnpm --filter @answra/ui exec vitest run test/toolPresentation.test.ts`：14 项通过；UI 全量 47 个文件、329 项通过。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm notes:check`：13 份本次 Note、42 个变更文件通过。
- `pnpm verify`：lint（898 文件）、notes:hint、全包 typecheck、全包测试（当时 agent 78/575、UI 47/329、CLI 49/305、desktop 53/350）、architecture:check、tokens:check 全部通过。之后补充队列失败释放用例，agent 全量重跑为 78/576 通过；其他包未变。
- 实机验证待补录：Windows CLI 和桌面端各跑一次不先 `Read` 的 `Edit`、连续两次 CRLF 编辑、外部编辑器修改后再次编辑。文件工具无 macOS 特定分支，macOS 仍沿用后续 CI/实机计划。
