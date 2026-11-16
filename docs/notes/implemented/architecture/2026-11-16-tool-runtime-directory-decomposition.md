# Note：Agent 工具运行时按文本、工作区与工具域拆分

状态：已实施

## 问题

Agent 的四个模型工具已经统一在 `apps/agent/src/core/tool`，但源码按文件平铺：

- `builtin/workspace.ts` 421 行，同时承担路径解析、编码识别、原子写入和编辑基线读取；
- `builtin/grep.ts` 430 行，把模型 schema、ripgrep 参数和 worker 执行混在一起；
- `builtin/shell/sessions.ts` 580 行，把会话类型、等待策略、输出快照和 LRU 管理放在同一个文件；
- Read/Grep/Edit/Shell 的文件命名、输出投影和平台适配没有目录边界，跨平台修复需要同时改多个平铺文件。

这使“改 shell 编码”或“加文件状态”时很难判断应落在哪一层，也让后续 macOS 验证和编码扩展继续扩大单文件职责。用户确认暂不做 macOS 实机验证，先收口目录结构。

## 涉及范围

- `apps/agent/src/core/tool/text/`：`encoding.ts`、`lineEndings.ts`、`streamDecoder.ts`。
- `apps/agent/src/core/tool/workspace/`：`paths.ts`、`textFile.ts`、`atomicWrite.ts`、`errors.ts`、`limits.ts` 与聚合入口 `index.ts`。
- `apps/agent/src/core/tool/state/readFileState.ts`。
- `apps/agent/src/core/tool/builtin/read/`：工具、输出与 `documents/`。
- `apps/agent/src/core/tool/builtin/grep/`：工具、schema、prompt、输出、worker 与 `ripgrep/`。
- `apps/agent/src/core/tool/builtin/edit/`：工具、匹配与 diff。
- `apps/agent/src/core/tool/builtin/runCommand/`：工具、环境提示、`process/` 与 `shell/`。
- `apps/agent/src/core/tool/names.ts`、`executor/abort.ts`、`core/tool/index.ts`。
- `apps/agent/package.json` 的 `./grep-worker` 导出与 `apps/agent/vitest.config.ts` 的覆盖率排除路径。
- Agent 测试仅更新导入路径；测试文件本身暂留原目录，避免把源码搬迁和测试目录搬迁混成一次大 diff。
- 协议、持久化、desktop IPC、工具行为与模型可见工具集合均不变。

## 决定

### 1. 文本层只处理字符串语义

- `text/encoding.ts` 统一 BOM 识别、UTF-8/UTF-16 解码、编码写回与二进制拒绝。
- `text/lineEndings.ts` 只做 LF/CRLF 检测与归一化。
- `text/streamDecoder.ts` 承载会话输出的跨 chunk 解码；shell 运行时不再导出该状态机。

### 2. 工作区层只处理路径与文件

- `workspace/paths.ts` 负责相对/绝对路径、盘符相对路径拒绝、VCS 目录拒绝和 realpath。
- `workspace/textFile.ts` 负责只读文本与编辑基线读取。
- `workspace/atomicWrite.ts` 负责临时文件、mtime/size 校验、编码/BOM/行尾/权限保留与独占创建。
- `workspace/errors.ts` 只做文件系统错误窄分类；`limits.ts` 集中字节上限。
- `workspace/index.ts` 是对外聚合入口；工具内部按需导入具体模块，避免路径层反向依赖工具层。

### 3. 工具域按模型工具拆分

- 每个工具进入 `builtin/<tool>/`；`builtin/index.ts` 只注册，不承载实现。
- Grep 的 schema、prompt、ripgrep 参数、ripgrep 执行和输出投影分开，`worker.ts` 继续作为独立 worker 入口。
- RunCommand 的模型提示移到 `environment.ts`；一次性执行、会话、进程树与 workdir 进入 `process/`；shell 检测、调用构造与输出清理留在 `shell/`。
- 会话的公开类型、等待策略与错误进入 `sessionContract.ts`，输出累计与快照进入 `sessionOutput.ts`，LRU 与生命周期管理留在 `sessions.ts`。
- `readFileState` 上移到 `state/`；`toolNames` 改名为 `names.ts`；取消检查上移到 `executor/abort.ts`。

## 曾考虑的替代方案

- **只移动文件、不拆 `workspace.ts` / `grep.ts` / `sessions.ts`：** 舍弃。平铺文件会变成“带子目录的大文件”，目录边界没有改变职责边界，后续仍要同时改路径、编码和写盘。
- **为 Bash、PowerShell、cmd 分别注册模型工具：** 舍弃。模型不应按平台选择工具；继续由 `RunCommand` 内部选择 shell provider。
- **把 shell 或文件能力搬到 desktop：** 舍弃。CLI 与桌面端共用 Agent 工具，desktop 代执行会破坏“工具只在 Agent 进程执行”的边界。
- **本轮同时迁移测试目录：** 暂缓。源码搬迁已足够验证分层；测试路径单独迁移可以避免相对导入和覆盖率配置同时变化，降低 review 成本。
- **在 `workspace/` 保留一个 421 行的兼容实现：** 舍弃。兼容入口只保留 `index.ts` 聚合导出，不保留重复实现。

## 后果与防回退

- 正面后果：文本、文件、状态和四个工具各有稳定落点；新增编码策略只改 `text/`，新增路径规则只改 `workspace/paths.ts`，新增 shell provider 只改 `runCommand/shell/`。
- 代价：导入路径更长；首次搬迁产生大量机械 diff；测试目录暂未与源码镜像。
- 防回退：
  - `builtin/index.ts` 不得重新承载工具实现；
  - `text/` 不得 import Electron、desktop 或具体工具；
  - `workspace/` 不得 import 具体工具，避免基础层反向依赖；
  - 会话的输出快照与等待策略不得重新塞回 `sessions.ts` 的公开契约；
  - `@answra/agent/grep-worker` 必须继续指向 `builtin/grep/worker.ts`，不得恢复已删除的平铺路径；
  - 目录重构不得改变模型可见工具集合、工具 ID、schema 或输出结构。

## 模块边界

- `core/tool` 只放工具契约、静态注册、执行器与内建工具；工具仍在 Agent 进程执行。
- `text/`、`workspace/`、`state/` 是 Agent 内 Node 能力，不包含桌面平台能力，也不依赖 React。
- `builtin/<tool>/` 只消费文本/工作区/状态层；工具之间不互相调用。
- `runCommand/process/` 管进程与会话，`runCommand/shell/` 管跨平台 shell provider；两层不复制终止或编码语义。
- CLI 与桌面端继续通过 `createBuiltinToolRegistry()` 使用同一套工具；desktop 只注入 grep worker 路径和工作区根目录。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent test`：78 个文件、584 项通过。
- 定向测试：`vitest run test/core/tool/shell test/core/tool/edit.test.ts test/core/tool/grep.test.ts test/core/tool/read.test.ts test/core/tool/workspace.test.ts`，10 个文件、151 项通过。
- `pnpm verify`（lint、全包 typecheck、全包测试、architecture、tokens）：通过。
- 覆盖：UTF-8 跨 chunk、GBK 回退、空文件 Edit、contentHash、PowerShell 错误清理、会话 LRU、进程树取消与超时。
- 未覆盖：测试目录镜像迁移、macOS CI、GBK/GB18030 文件自动识别；这些仍留在跨平台提案中。
