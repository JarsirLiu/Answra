# Note：Grep 工具接入 WASI ripgrep

状态：已实施

## 问题

旧 `Grep` 用 `fs` 递归加 `String.includes` 做字面搜索，却暴露 `Grep` 名称和 `pattern` 参数；模型按正则调用时会静默漏结果。工具还有四类实际缺陷：固定扩展名白名单导致 `.py`、`.go`、`.rs`、`Dockerfile`、`.env` 搜不到；`path` 用原始字符串比较，Windows 反斜杠与规范化路径不匹配；超过 128 KiB 的文件直接跳过且不告知模型；输出只是拼接字符串，没有结构化结果、分页、上下文和 20k 模型字节预算。

本次把 `Grep` 升级为 ZCode 同款 WASI ripgrep：支持正则、glob/type、上下文、only-matching、multiline、分页和结构化输出，并把搜索放入 `worker_threads`，避免阻塞 Agent utility process。

## 涉及范围

- `apps/agent/src/core/tool/builtin/grep.ts`：工具 schema、路径解析、ripgrep 参数、worker 调用和错误归一。
- `apps/agent/src/core/tool/builtin/grepOutput.ts`：`GrepOutput`、ripgrep JSON 解析、上下文合并、分页和模型投影。
- `apps/agent/src/core/tool/builtin/grepWorker.ts`：WASI ripgrep worker 入口。
- `apps/agent/src/core/tool/builtin/workspace.ts`：文件/目录目标解析；移除扩展名白名单与手写递归遍历；普通点文件可访问，仅拒绝版本库目录；工作区是默认搜索根而非访问边界。
- `apps/agent/src/core/tool/contracts.ts`、`registry.ts`、`index.ts`：工具 worker 路径注入和 `ToolResultBudget.maxModelBytes`。
- `apps/agent/src/host.ts`、`apps/desktop/src/main/conversation/workerTransport.ts`、`apps/desktop/src/main/conversation/grepWorker.ts`：组合根注入 worker；仅 chat profile 构建 worker。
- `apps/desktop/scripts/build-electron.mjs`、`apps/desktop/scripts/audit-packaged-input.mjs`：打包 worker、修正迁移后遗留的旧工具路径审计。
- `apps/agent/test/core/tool/grep.test.ts`、`builtinTools.test.ts`、`executeToolCall.test.ts`：正则、glob/type、上下文、分页、multiline、隐藏文件、忽略规则、大文件、字节预算和取消测试。
- 相关 Note：`2026-10-26-workspace-agent-read-tools.md`（旧行为）、`2026-11-09-read-tool-text-quality.md`（路径/隐藏规则联动）、`2026-11-09-agent-tool-system-foundation.md`（工具契约）。

## 影响表面

- 模型可以按 ripgrep 正则搜索工作区，使用 `output_mode=content/files_with_matches/count`，`glob`、`type`、`-A/-B/-C`、`-n`、`-i`、`-o`、`head_limit`、`offset`、`multiline`。
- 默认 `files_with_matches`，默认 `head_limit=250`；`content` 返回带行号匹配行和上下文行，`count` 返回每文件匹配行数。
- 默认遵守 `.gitignore`，搜索隐藏文件（包括 `.env`），固定排除 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`。
- 不再按扩展名白名单筛选，也不因 128 KiB 文件大小直接跳过；单行展示超过 500 字符时截断。
- 模型可见内容上限为 20,000 字节；结果被截断时附加标记。
- 搜索在 worker 内运行，超时或取消会 terminate worker；只有测试或无宿主注入时退回进程内执行。
- 首次搜索会从包内 WASM 解压并缓存到系统临时目录；不会下载原生二进制，也不依赖 PATH 上的 `rg`。

## 决定

- 使用 npm `ripgrep@0.3.1` 的 WASI 版，和 ZCode 的 `Grep` handler 同一条路线；固定参数包含 `--json --no-config --hidden --max-columns 500` 与版本库目录排除 glob。
- `pattern` 直接作为 ripgrep 正则；非法正则由 ripgrep stderr 归一为 `invalid-input`，不再静默当字面量。
- `path` 支持工作区相对路径、任意绝对路径和工作区外相对路径；统一 `realpath` 后，对目录以目录自身、对文件以父目录作为 WASI preopen，并转换为 guest 路径。工作区外结果输出绝对路径。
- 普通点文件可访问；只拒绝版本库目录。原因是 `.env`、`.github`、`.vscode` 等是正常文本目标，而 `.git` 内容不应进入模型上下文。
- `type` 不是 ripgrep `--type`，而是映射到 `--glob`；未知 type 按扩展名处理。
- 输出模式：
  - `content`：匹配行用 `path:line:text`，上下文用 `path-line-text`；上下文不连续时插 `--`。
  - `files_with_matches`：每个文件只出现一次。
  - `count`：每个文件输出匹配行数。
- 分页以“匹配记录”为单位，`offset` 跳过匹配，`head_limit=0` 表示不限；模型字节预算另行截断。
- `-o` 使用 ripgrep JSON 的 `submatches` 生成仅匹配文本；`multiline` 启用 `--multiline --multiline-dotall`。
- `ToolResultBudget` 增加可选 `maxModelBytes`；Grep 同时限制 20,000 字符和 20,000 字节，按 UTF-8 字节安全截断，避免中文被切半。
- `createBuiltinToolRegistry` 接收 `workerPaths`；desktop 组合根注入 `grepWorker.cjs`。worker 文件只随 chat profile 构建，answer profile 不携带。
- `audit-packaged-input.mjs` 的 workspace 特征路径从已删除的 `conversation/tools` 更新为 `core/tool`，避免 profile 审计继续检查不存在的路径。

## 曾考虑的替代方案

- **直接打包原生 rg 14.x：** 舍弃。需要 Windows/macOS 多架构二进制、asarUnpack、升级/哈希/许可证维护；当前 Grep 需求用 WASI 即可覆盖。
- **继续用 JS `RegExp` 自己遍历：** 舍弃。正则、ignore、二进制、上下文、multiline 和性能会逐步分叉；WASI ripgrep 与 ZCode 语义更接近。
- **保留字面搜索但改名 `Search`：** 舍弃。模型需要正则搜索；改名只能消除误导，不能补上能力。本轮选择真正实现 regex，因此保留 `Grep`。
- **所有搜索都在 Agent 主线程执行：** 舍弃。WASI 调用会占用 Agent utility process 事件循环，`timeoutMs` 无法可靠生效；worker 才能 terminate 并隔离长搜索。
- **继续使用 128 KiB 文件上限：** 舍弃。静默跳过会让模型误判“没有结果”；改为搜索并依靠输出预算截断。
- **继续拒绝所有隐藏路径：** 舍弃。它会让 `.env` 可被 Grep 但不可被 Read；普通点文件属于用户显式选择的工作区，版本库目录才是明确禁区。
- **继续把搜索限制在工作区内：** 舍弃。用户明确要求工作区只作为优先目录；Grep 需要能搜索工作区外路径，preopen 因此改为绑定实际搜索根，策略见 `../architecture/2026-11-09-workspace-default-root-not-boundary.md`。
- **完整照搬 ZCode 的 type 表、mtime 排序和 artifact：** 部分舍弃。当前实现覆盖常用 type 与正则/上下文/分页；mtime 排序和 artifact 尚未实现，避免本轮引入额外排序 stat 和存储面。

## 后果与防回退

- 正面后果：`Grep` 名称与 regex 语义一致；路径、ignore、上下文、分页和输出预算可预测；搜索不再阻塞 Agent 事件循环；`.env`、无扩展名和大于 128 KiB 的文本可被搜索。
- 代价：worker bundle 约增加 736 KB；首次搜索有 WASM 解压/缓存成本；PCRE2 不可用；不支持 `--type` 的完整语言表、mtime 排序和 artifact 结果。
- 防回退：
  - 不得把 `pattern` 重新降级为 `String.includes`。
  - 不得恢复扩展名白名单作为 Grep 的准入条件。
  - 不得跳过大于 128 KiB 的文本文件而不告知模型。
  - `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl` 必须继续排除。
  - `head_limit` 与 `offset` 必须按匹配记录分页，不能先拼接全部结果再截字符串。
  - 模型可见内容必须同时受 20,000 字节上限约束；字节截断不得切坏 UTF-8 字符。
  - worker 超时/取消必须 terminate，不得留下后台 WASI 调用。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm --filter @answra/agent test`：27 个测试文件、193 个测试通过。
- `pnpm exec vitest run test/core/tool/grep.test.ts test/core/tool/builtinTools.test.ts test/core/tool/registry.test.ts test/core/tool/executeToolCall.test.ts test/conversation/turn/workspaceContext.test.ts`：47 个测试通过。
- 新增覆盖：regex、非法正则、files/count/content、glob/type、上下文、`-o`、Windows 路径、绝对路径、工作区外路径与输出投影、`.gitignore`、`.env`、版本库排除、大于 128 KiB 文件、`head_limit`/`offset`、multiline、无结果、缺失路径、取消、20k 字节预算、UTF-8 字节截断。
- `pnpm --filter @answra/desktop build:electron -- --profile=full`：通过，生成 `grepWorker.cjs`。
- 用 Node `worker_threads` 直接执行构建后的 `grepWorker.cjs`，成功返回 ripgrep JSON；worker 路径与 WASI 预开放目录验证通过。
- 实机 Electron 对话中的 Grep 调用和 asar 内 worker 加载仍需在安装包中验收。

## 风险

- Electron 打包后的 worker 从 asar 加载依赖 Electron 的 asar worker 支持；本轮只在 Node 构建产物上冒烟，未在安装包内触发真实工具调用。
- WASI ripgrep 在超大工作区仍可能产生较大 JSON stdout；当前依赖 16 MiB raw 上限和 worker 超时兜底，后续应补流式解析或提前终止。
- `--hidden` 会搜索 `.env` 等敏感文件；这是用户选择工作区后的显式搜索能力，仍需在 UI/产品层确认是否需要额外提示。
