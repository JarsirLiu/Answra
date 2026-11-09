# Note：工作区从访问边界改为默认根目录

状态：已实施

## 问题

`Read`/`Grep` 早期把用户选择的 workspace 同时当作访问边界：任何工作区外绝对路径、相对遍历或指向外部的符号链接都会被拒绝。用户明确要求不要锁住工作区，工作区只是优先工作目录；当前硬边界会让模型在用户明确指向其他目录时产生不必要的失败，也与 ZCode 的路径策略不一致。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/tool/builtin/workspace.ts`：路径解析、`realpath`、VCS 排除、Read/Grep 共用目标。
  - `apps/agent/src/core/tool/builtin/read.ts`：无 workspace 时的绝对路径与缺失文件提示。
  - `apps/agent/src/core/tool/builtin/grep.ts`：工作区外 `path`、实际搜索根、输出路径投影。
  - `apps/agent/src/core/tool/builtin/grepWorker.ts`：WASI preopen 使用实际搜索根。
  - `apps/agent/src/conversation/turn/workspaceContext.ts`、`apps/agent/src/conversation/profiles/registry.ts`：提示词改为“优先工作区，不是边界”。
- UI/进程/协议/持久化表面：不新增 IPC 频道，不改变 worker 线协议；desktop 仍只下发工作区根目录。
- 相关 Note：
  - `../feature/2026-10-26-workspace-agent-read-tools.md`
  - `../feature/2026-11-07-conversation-workspace-system-context.md`
  - `../feature/2026-11-09-read-tool-text-quality.md`
  - `../feature/2026-11-09-grep-ripgrep-tool.md`

## 模块边界

- 工作区路径解析仍属于 Agent 进程内的 `core/tool/builtin/workspace.ts`，desktop 不代执行文件读取或搜索。
- `workspaceRoot` 只作为相对路径基线和 Grep 默认搜索根；绝对路径不要求落在该根目录下。
- VCS 目录排除仍是工具自身的安全规则，不依赖 desktop 的 workspace service。
- desktop 的 `workspaceService` 继续服务于笔记本选择/相对路径解析，不等同于 Agent 工具的访问边界。

## 决定

- `resolveInputPath(root, inputPath)`：
  - 绝对路径直接解析；
  - 相对路径优先相对 `workspaceRoot`；
  - 没有 workspace 时，相对路径返回明确错误并要求绝对路径；
  - 盘符相对形式（如 `C:foo`）继续拒绝。
- 解析后执行 `realpath`，再按目录段排除 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`；工作区外路径和指向外部的符号链接不再因“越界”被拒绝。
- `resolveToolTarget` 同时返回 `target`、`kind`、`searchRoot`、`guestPath`；Grep 对文件目标使用父目录作为 preopen，对目录目标使用目录自身，避免把整个工作区当作外部路径的 preopen。
- Grep 输出路径：位于工作区内时显示工作区相对路径；位于工作区外时显示绝对路径。默认省略 `path` 时仍搜索整个工作区。
- Read 缺失文件提示保留工作区根目录信息；无 workspace 时说明按绝对路径查找。
- prompt 明确“工作区不是访问边界”，要求优先工作区，只在用户明确指向或工作区没有所需内容时访问其他目录。

## 曾考虑的替代方案

- **继续保留工作区硬边界：** 舍弃。与用户明确要求冲突，且会让模型无法读取用户指定的工作区外文件；安全责任改由 VCS 排除和真实路径校验承担。
- **只允许工作区外绝对路径，不允许相对遍历：** 舍弃。相对路径是模型和用户常用表达；`realpath` 后再判断 VCS 已足够明确，不需要额外的字符串边界规则。
- **没有 workspace 时也允许相对路径，按进程 cwd 解析：** 舍弃。cwd 不是用户选择的目录，容易产生不可解释的读取结果；要求绝对路径更可审计。
- **Grep 继续固定以工作区根为 preopen：** 舍弃。工作区外路径无法被 WASI 访问；必须让 preopen 绑定实际搜索根。
- **把工作区外结果也显示为工作区相对路径：** 舍弃。会产生 `../` 或跨盘符路径，模型无法可靠复用；工作区外直接显示绝对路径。

## 后果与防回退

- 正面后果：用户可以用绝对路径或相对路径访问任意非 VCS 文本；Grep 可以对工作区外目录执行正则搜索；提示词不再错误声明工具不可用。
- 代价：Agent 工具的文件访问面扩大到进程权限范围；安全边界只剩 VCS 排除、真实路径校验和文件类型/大小限制。需要依赖用户对模型工具调用的可见性与产品层权限控制。
- 防回退：
  - 不得重新引入 `workspaceRoot` 的字符串前缀边界检查。
  - `.git` 等 VCS 目录必须继续排除，且检查应在 `realpath` 后执行，防止符号链接绕过。
  - Grep 的 WASI preopen 必须绑定 `searchRoot`，不得固定为 `workspaceRoot`。
  - 无 workspace 时相对路径必须明确失败，不得静默退化到 cwd。
  - 模型提示词不得再宣称未选择工作区时 `Read`/`Grep` 不可用。

## 验证

- `apps/agent/test/core/tool/builtinTools.test.ts`：工作区外相对路径、绝对路径、符号链接目标均可读；VCS、二进制仍拒绝；Grep 可搜索工作区外目录；无 workspace 时绝对路径可用、相对路径失败。
- `apps/agent/test/core/tool/grep.test.ts`：工作区外相对 `path` 可搜索并输出绝对路径；缺失路径仍失败。
- `apps/agent/test/conversation/turn/workspaceContext.test.ts`：已选择工作区声明为默认根、不是边界；未选择工作区仍要求绝对路径。
- `pnpm verify`：Biome、全包 typecheck、全包测试与架构检查通过；Agent 193 项、UI 229 项、desktop 277 项测试通过。
- `pnpm notes:check`：通过。
- 真实模型 function calling 与桌面端工具活动尚未实机验收。
