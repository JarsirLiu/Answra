# Note：Agent 工具运行时跨平台收口与目录契约

状态：提案

## 现状

截至 2026-11-16，本提案中影响工具行为正确性的 P0 已落地：

- 模型可见工具仍只有 `Read`、`Grep`、`Edit`、`RunCommand` 四个；CLI 与桌面端继续共用 `createBuiltinToolRegistry()`，没有第二套工具实现。
- Windows shell 已按 `pwsh` → `powershell.exe` 检测，支持显式 cmd 与 30K 命令上限；macOS 默认 zsh。续接会话改为跨 chunk 流式解码，不再按字节切片后单独猜测编码。
- 2026-11-17 起 `ReadFileState`/`contentHash` 已整体删除：`Edit` 自读文件，`Read` 无状态，重复 Read 直接返回文本；已有空文件由 Edit 自读确认后回填。
- 工具源码已按职责拆分：`text/`（编码与行尾）、`workspace/`（路径、文本文件、原子写入、错误与限制）、`executor/`（执行与取消）、`builtin/<tool>/`（Read/Grep/Edit/RunCommand 各自实现）。`builtin/index.ts` 只负责注册；`state/` 已随读取状态删除。
- 测试文件仍保留原目录，只更新了 import 路径；测试目录镜像、macOS CI 和更大范围的编码策略尚未实施。
- 已验证：`pnpm --filter @answra/agent test` 78 文件/584 项通过，完整 `pnpm verify` 通过；macOS 尚无实机或 CI 证据。

详见 `docs/notes/implemented/feature/2026-11-16-agent-tool-cross-platform-shell-and-edit-state.md` 与
`docs/notes/implemented/architecture/2026-11-16-tool-runtime-directory-decomposition.md`。

## 问题

当前核心能力可用，但仍存在以下差距：

- 文件读取和编辑只支持 UTF-8/UTF-16；Windows 常见的 GBK/GB18030 文本会 fail-closed 拒绝，虽然不会写坏，但工具不可用（`apps/agent/src/core/tool/text/encoding.ts`、`workspace/textFile.ts`）。
- Shell 非 UTF-8 输出一律回退 GBK；这只适合中文 Windows，英文 Windows 的 OEM code page、Big5、Shift-JIS 或 macOS 非法字节都会解错（`builtin/runCommand/shell/runtime.ts`）。
- 测试目录仍与源码目录平铺不一致，后续按职责新增测试时容易继续堆在旧路径。
- CI 只跑 `windows-latest`，没有 macOS 证据；`sessions.test.ts` 的容量测试还硬编码 `Start-Sleep`，macOS 直接不可用。

本提案只处理 **Agent 工具运行时**。这里没有“CLI 工具”和“桌面端工具”两套实现：

- CLI 通过 `apps/cli/src/main.ts` → `startCodingHost()` → `createBuiltinToolRegistry()` 获得工具。
- 桌面端通过 `apps/agent/src/host.ts` → `createBuiltinToolRegistry()` 获得同一套工具；Electron utility process 只是宿主，`workerTransport.ts` 额外注入 `grepWorker.cjs`。
- coding、general-chat、interview-rehearsal 三个 profile 都声明同一组 `workspace.read`、`workspace.grep`、`workspace.edit`、`workspace.run-command`；截图答题 Agent 不授权工具。

因此工具修复一次即同时作用于 CLI 和桌面端。两端差异只在传输、展示、workspaceRoot 注入和 Grep worker 注入，不在工具实现。

参考本地 OpenCode（`D:\codespace\opencode`）的 Bash/Shell 工具；只借鉴跨平台 shell 选择与提示机制，不复制其 Effect、权限、插件或多工具体系：

- `packages/opencode/src/tool/shell/id.ts`：对外工具 ID 固定为 `bash`，内部再区分 `bash`、`pwsh`、`powershell`、`cmd`；不为每个 shell 暴露一个模型工具。
- `packages/core/src/shell.ts`：Windows 检测顺序为 `pwsh` → `powershell` → Git Bash → `cmd.exe`；POSIX 读取 `/etc/shells`，macOS 兜底 `/bin/zsh`；统一 `args()`，POSIX 用进程组终止，Windows 用 `taskkill /T`。
- `packages/opencode/src/tool/shell/prompt.ts`：同一工具按实际 shell 生成不同提示；PowerShell 5.1 明确不要用 `&&`，路径分隔符、here-string 和 `workdir` 示例按平台变化。
- `packages/opencode/src/tool/shell.ts`：参数只有 `command`、`timeout`、`workdir`；把 `cd` 引导到 `workdir`，不靠模型猜平台。
- `packages/opencode/src/util/process.ts`：`windowsHide`、进程终止和超时处理。

OpenCode 的 `bash` 工具在 Windows 上经常实际执行 PowerShell，名字仍叫 Bash；这说明跨平台的关键不是改工具名，而是内部 shell provider。Answra 当前模型名是 `RunCommand`，本轮保持不改名，内部采用同样机制。

Answra 已有 OpenCode 没有的续接会话、Windows Job Object 和流式快照；这些能力保留，不因参考 OpenCode 而降级为 `taskkill` 或一次性命令。

## 涉及范围

- 工具契约与注册：
  - `apps/agent/src/core/tool/contracts.ts`
  - `apps/agent/src/core/tool/registry.ts`
  - `apps/agent/src/core/tool/names.ts`
  - `apps/agent/src/core/tool/builtin/index.ts`
- 两个宿主共用同一工具注册表：
  - CLI：`apps/cli/src/main.ts` → `apps/agent/src/coding/host.ts`
  - 桌面端：`apps/desktop/src/main/conversation/workerTransport.ts` → `apps/agent/src/host.ts`
- 文件工具：
  - `apps/agent/src/core/tool/text/`
  - `apps/agent/src/core/tool/workspace/`
  - `apps/agent/src/core/tool/builtin/read/`
  - `apps/agent/src/core/tool/builtin/grep/`
  - `apps/agent/src/core/tool/builtin/edit/`
- Shell 工具：
  - `apps/agent/src/core/tool/builtin/runCommand/`
  - `apps/agent/src/core/tool/executor/`
- 展示层不改语义：
  - `packages/ui/src/tool-presentation/`
  - `packages/ui/src/components/tool-call/renderers/`
  - `apps/cli/src/presentation/`
- 测试与 CI：
  - `apps/agent/test/core/tool/`
  - `apps/cli/test/`
  - `.github/workflows/ci.yml`
- 协议、持久化、desktop IPC：无变化。
- 相关 Note：
  - `docs/notes/implemented/feature/2026-11-09-shell-tools-and-session-runtime.md`
  - `docs/notes/implemented/feature/2026-11-10-workspace-edit-tool.md`
  - `docs/notes/implemented/bug-fix/2026-11-16-shell-output-valid-utf8-replacement-character.md`
  - `docs/notes/implemented/feature/2026-11-16-workspace-edit-create-file.md`
  - `docs/notes/implemented/architecture/2026-11-16-merge-write-stdin-into-run-command.md`
  - `docs/notes/implemented/feature/2026-11-16-agent-tool-cross-platform-shell-and-edit-state.md`
  - `docs/notes/implemented/architecture/2026-11-16-tool-runtime-directory-decomposition.md`
  - `docs/notes/proposed/architecture/2026-11-17-shell-process-tree-interrupt-convergence.md`

## 提案

### 1. 范围与原则

- 保持模型可见工具为 `Read`、`Grep`、`Edit`、`RunCommand` 四个，不新增 `Write`、`Glob`、`WriteStdin`。
- CLI 与桌面端共用 `createBuiltinToolRegistry()` 的同一套工具；不建立第二套桌面工具，也不建立第二套 CLI 工具。
- 平台差异留在工具运行时内部；模型只看到一份工具契约，不按 Windows/macOS 暴露不同工具名。
- Agent 继续只使用 Node 内置能力，不引入 Electron 或 desktop 平台能力。
- 先修行为正确性，再做目录重构；结构重构不能改变工具语义。
- 不照抄 OpenCode 的多工具生态、Effect 运行时、MCP/LSP、权限弹窗和插件体系。

### 2. 当前目录

```text
apps/agent/src/core/tool/
  contracts.ts
  index.ts
  names.ts
  registry.ts
  executor/
    abort.ts
    executeToolCall.ts
    result.ts
    resultBudget.ts
    timeout.ts

  text/
    encoding.ts
    lineEndings.ts
    streamDecoder.ts

  workspace/
    paths.ts
    textFile.ts
    atomicWrite.ts
    errors.ts
    limits.ts
    index.ts

  builtin/
    index.ts                  # 只注册，不放实现

    read/
      tool.ts
      output.ts
      documents/{contracts,documentFormat,documentText,pdfText,wordText}.ts

    grep/
      tool.ts
      schema.ts
      prompt.ts
      output.ts
      worker.ts
      ripgrep/{args,runner}.ts

    edit/
      tool.ts
      match.ts
      diff.ts
      mutationQueue.ts

    runCommand/
      tool.ts
      environment.ts
      shell/runtime.ts
      process/
        oneShot.ts
        sessions.ts
        sessionContract.ts
        sessionOutput.ts
        processTree.ts
        workdir.ts
```

未保留原目标中的 `prompt.ts`、`schema.ts`、`execute.ts` 机械拆分：现有工具已在 `tool.ts` 内保持 prompt/schema/执行入口的单一来源，强行拆开会扩大 diff 而不增加边界。`sessions.ts` 已降到 396 行，会话类型/等待策略与输出累计分别位于 `sessionContract.ts`、`sessionOutput.ts`。

测试目录镜像尚未实施，目标如下：

```text
apps/agent/test/core/tool/
  text/
    encoding.test.ts
    lineEndings.test.ts
    streamDecoder.test.ts
  workspace/
    paths.test.ts
    textFile.test.ts
    atomicWrite.test.ts
  builtin/
    read.test.ts
    read.documents.test.ts
    grep.test.ts
    edit.test.ts
    runCommand.test.ts
    runCommand.sessions.test.ts
    runCommand.processTree.test.ts
```

`packages/ui` 仍是唯一展示层；工具目录不出现 React。

### 3. 文本编解码

- `text/encoding.ts` 识别 UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM；无 BOM 默认严格 UTF-8。
- 不在 Read/Edit/Shell 内各写一套 `TextDecoder`。
- 文件编辑保留原编码、BOM、CRLF/LF 和 mode；无法识别编码时 fail-closed，不写盘。
- GBK/GB18030 不作为默认自动猜测；如产品需要，增加显式编码参数或显式配置，并单独记录决策。
- `streamDecoder.ts` 必须保留不完整 UTF-8 尾部；只有完整非法序列才允许切换兜底编码，不能因为 chunk 边界误判。

### 4. 文件状态与 Edit（2026-11-17 已收口）

- 不再引入 `ReadFileStateEntry`、`contentHash`、LRU 或路径键归一化；这些状态已随 [移除工具读前状态与 Edit 读前门禁](../../implemented/simplification/2026-11-17-remove-tool-read-state-and-edit-read-gate.md) 删除。
- `Edit` 在单次调用内自读文件，按精确匹配写入；同一路径由 `builtin/edit/mutationQueue.ts` 串行。
- 路径解析、VCS 排除、编码/BOM/行尾/权限保留和原子写继续由 `workspace/` 负责。
- `Edit` 规则：
  - 文件不存在 + `old_string=""`：新建。
  - 文件存在且 size 为 0 + `old_string=""`：Edit 自读确认后写入，不要求先 Read。
  - 文件存在且非空 + `old_string=""`：拒绝。
  - 非空 `old_string`：要求精确匹配、唯一匹配或 `replace_all`。

### 5. RunCommand 与 Shell provider

`RunCommand` 就是 Answra 的 Bash 工具：模型只看到一个工具，内部按平台选择 shell：

```text
RunCommand
  ├─ BashProvider：zsh / bash / sh，POSIX 参数 -c
  ├─ PowerShellProvider：pwsh（7+）或 powershell.exe（5.1）
  └─ CmdProvider：仅在 Windows 无 PowerShell 且无 POSIX shell 时兜底
```

- Windows 检测顺序照 OpenCode：`pwsh` → `powershell` → Git Bash → `cmd.exe`；默认取第一个可用项，不写死 `powershell.exe`。
- macOS 检测顺序：`$SHELL`（若可接受）→ `/bin/zsh` → `/bin/bash` → `/bin/sh`；`$SHELL` 是 fish 等非 POSIX shell 时不直接当 Bash 用。
- `detect.ts` 返回 `{ executable, kind, syntax }`；`kind` 只用于选提示、选参数和选终止策略，不暴露成第二个模型工具。
- `prompt.ts` 按 `kind` 生成提示：
  - PowerShell 5.1：禁止 `&&`，改用 `cmd1; if ($?) { cmd2 }`；提醒 here-string、反引号转义和 `workdir`。
  - PowerShell 7+：允许 `&&`，但仍优先 `workdir`。
  - POSIX：`command` 用 `$SHELL -c`；路径、引号和并行命令说明按 bash/zsh 生成。
  - 所有平台都要求用 `workdir` 参数，不鼓励 `cd`。
- 短命令走 `-Command`；长命令或复杂引号走临时 `.ps1` + `-File`，并确保失败时清理。
- Windows 命令长度上限纳入 schema/执行校验，不能继续允许 64K 字符直接塞进命令行。
- `processTree.ts` 保持现有 Windows Job Object 与 POSIX 进程组两条路径；一次性命令与会话共用同一套 spawn/terminate 选项。OpenCode 的 `taskkill /T` 只作参考，不替换现有 Job Object。
- `decoder.ts` 每个会话的 stdout/stderr 各持有独立 `TextDecoder` 状态；会话快照只返回新增完整字符，不重复、不切坏。
- Shell 环境描述收敛到 `runCommand/environment.ts`，避免 `coding/context.ts` 与 `conversation/turn/environmentContext.ts` 继续各写一份。

### 6. 测试与 CI

- 增加不可变行为测试：
  - UTF-8 中文字符跨 chunk；
  - GBK 完整字节输出；
  - UTF-16LE/BE 与 BOM；
  - CRLF 编辑与新文件 LF；
  - 中文文件名 Grep；
  - 已存在空文件 Edit；
  - Windows 长命令；
  - POSIX 进程树终止。
- 把 `sessions.test.ts` 中硬编码 `Start-Sleep` 的容量测试改成 Node 脚本，保证 macOS 可运行。
- CI 增加 macOS job，至少运行 `@answra/agent` typecheck 与测试；是否运行完整 desktop build 取决于后续桌面端范围。
- 不把 Windows Job Object 测试伪装成跨平台测试；Windows 专用行为继续显式按平台跳过。

### 7. 权限与审计边界

- 本提案不新增逐工具权限弹窗。
- 后续在 `core/tool/policy/` 统一做 allow/ask/deny、路径规则、审计和持久化修改确认；工具只声明 metadata，不各自实现权限 UI。
- 与产品方向 Note 的“持久化修改需差异预览和用户可见确认”保持一致；该层不在本轮工具目录重构中预埋空实现。

## 模块边界

- `core/tool` 仍只放跨域工具契约、注册、执行与通用工具；不导入任何领域。
- `createBuiltinToolRegistry()` 是 CLI 与桌面端共用的唯一工具装配入口；不出现按宿主分叉的第二套工具目录。
- `workspace/`、`text/` 是 Agent 内 Node 能力，不是 desktop 平台能力；`state/` 已删除，不得借跨平台改造恢复会话读取状态。
- `packages/ui` 只消费结构化输出和工具事件；不解析 shell 输出、不判断编码。
- desktop 不代执行 Agent 工具；本提案不新增反向 RPC。
- `RunCommand` 是唯一模型工具；平台 provider 不是模型可见工具。
- `Edit` 是唯一写文件工具；不新增 `Write`。
- desktop 平台能力不在本提案边界内；工具运行时只依赖 Node。

## 曾考虑的替代方案

- **完整照搬 OpenCode 工具层：** 舍弃。OpenCode 有 Effect、插件、权限、MCP/LSP 和多工具生态；Answra 只保留 4 工具白名单，借鉴 shell 选择、提示生成和进程终止即可。
- **把每个 shell 都暴露成独立模型工具：** 舍弃。模型不应先判断平台再选 `Bash` 或 `PowerShell`；一个 `RunCommand` 内部选择 shell，契约更稳定。
- **只修当前乱码 bug，不拆目录：** 舍弃。`workspace.ts` 421 行、`grep.ts` 430 行、`sessions.ts` 560 行已经同时承担路径、编码、写入和进程职责，下一轮跨平台修复还会继续扩散。
- **新增独立 `Write` 工具：** 舍弃。用户已决定 `Edit` 兼顾新建；先补“已有空文件”规则即可，避免模型工具膨胀。
- **拆成 BashTool 与 PowerShellTool 两个模型工具：** 舍弃。Answra 的模型不需要选择平台；内部 provider 已能隔离差异。
- **给 CLI 和桌面端各做一套工具：** 舍弃。两端已经共用 `createBuiltinToolRegistry()`；复制两套会让编码、路径和进程修复再次漂移，且没有第二个独立实现能证明这种拆分有必要。
- **只修一个宿主：** 舍弃。桌面端和 CLI 走同一个工具运行时，修一个宿主等于修两端；实际差异只在宿主和展示层。
- **自动检测 GBK/GB18030：** 暂不采用。无 BOM 文本的编码自动猜测会制造静默误写；先 fail-closed，等真实需求出现再做显式支持。
- **把所有桌面平台能力都做 mac 适配：** 不在本提案。本提案只保证同一套 Agent 工具在 Windows/macOS 可用。
- **把权限、审计、diff 确认一起做进本轮：** 暂不做。先稳定编码和目录，权限层需要单独设计用户交互与持久化。

## 验收标准

- 可观察结果：
  - CLI 和桌面端使用同一套工具注册表；一次修复同时作用于两个宿主。
  - 续接长命令输出中文不再出现因 chunk 边界导致的乱码。
  - UTF-8/UTF-16LE/UTF-16BE 文件可读可编辑；不支持编码明确报错且不写盘。
  - 新建文件、编辑 CRLF 文件、填充已存在空文件行为符合上述规则；Edit 不要求历史 Read。
  - Windows 使用 `pwsh` 或 PowerShell 5.1 时提示与调用一致；macOS 使用 POSIX provider。
- 自动化验证：
  - 新增 `streamDecoder`、`encoding`、`atomicWrite`、`edit`（含未读编辑与同路径串行）、`runCommand` 测试；不恢复 `readFileState` 测试。
  - `pnpm --filter @answra/agent test` 在 Windows 与 macOS 通过。
  - `@answra/agent`、`@answra/ui`、`@answra/cli` typecheck 通过。
  - `pnpm notes:check`、`pnpm architecture:check` 通过。
- 需要实机验证的内容：
  - Windows PowerShell 5.1、安装 `pwsh` 的 Windows、macOS 默认 zsh 各跑普通命令、长命令、含中文输出、取消和进程树终止。
  - Windows 中文 GBK 文件如果本轮不承诺支持，必须验证报错可读且不写盘。

## 风险

- 正面：编码问题已从“每次快照独立猜”变成一条可测试的流式解码链；工具目录已按职责拆分，后续加平台或工具不会继续堆在 `workspace.ts` / `sessions.ts`。
- 正面：`Edit` 补齐空文件规则后，不新增 `Write` 也能覆盖完整的新建/写入流程。
- 负面：目录移动已产生较大 diff；本次先完成行为测试，再机械迁移，测试目录刻意未同步迁移，避免结构、导入和行为变化混在同一次 diff。
- 负面：macOS CI 需要修复测试中的平台假设，并增加 CI 时间；同一套工具要在两个宿主上成立，这是必要成本。
- 风险：流式编码仍只能可靠覆盖 UTF-8 与受控兜底；GBK 文件、其他本地编码和原生程序硬编码输出仍需要产品级编码策略，不能承诺“所有编码都不出错”。
- 风险：Windows 长命令临时脚本涉及临时文件清理和权限边界，需要测试失败清理路径。
- 不在本提案承诺：完整 macOS Electron 桌面端和 desktop 平台能力。
