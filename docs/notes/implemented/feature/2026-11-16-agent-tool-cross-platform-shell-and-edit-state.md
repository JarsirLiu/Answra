# Note：Agent 工具跨平台 Shell、流式输出与空文件编辑

状态：已实施

## 问题

同一套 Agent 工具在 Windows 与 macOS 上存在四个具体缺口：

- `RunCommand` 在 Windows 写死 `powershell.exe` 5.1；即使安装了 `pwsh` 也不会使用，平台提示也固定为 PowerShell。
- 续接会话按字节 offset 切新增输出，再对切片单独解码；UTF-8 中文字符跨 chunk 时会触发 GBK 回退，产生乱码。
- `Edit` 拒绝“已存在空文件 + `old_string=""`”；没有独立 `Write` 工具时，Read 后的空文件无法写入。
- `ReadFileState` 只比较 mtime/size；Windows 云同步或杀毒软件触碰 mtime 会造成假冲突。

CLI 与桌面端共用 `createBuiltinToolRegistry()`，因此这些问题一次修复同时作用于两个宿主。

## 涉及范围

- Shell 运行时与提示：
  - `apps/agent/src/core/tool/builtin/shell/runtime.ts`
  - `apps/agent/src/core/tool/builtin/shell/localShell.ts`
  - `apps/agent/src/core/tool/builtin/shell/sessions.ts`
  - `apps/agent/src/core/tool/builtin/shell/tools.ts`
  - `apps/agent/src/coding/context.ts`
  - `apps/agent/src/conversation/turn/environmentContext.ts`
  - `apps/agent/src/core/tool/index.ts`
- 文件编辑与状态：
  - `apps/agent/src/core/tool/builtin/edit.ts`
  - `apps/agent/src/core/tool/builtin/read.ts`
  - `apps/agent/src/core/tool/builtin/readFileState.ts`
  - `apps/agent/src/core/tool/contracts.ts`
- 测试：
  - `apps/agent/test/core/tool/shell/runtime.test.ts`
  - `apps/agent/test/core/tool/shell/sessions.test.ts`
  - `apps/agent/test/core/tool/edit.test.ts`
  - `apps/agent/test/conversation/turn/environmentContext.test.ts`

## 决定

- `resolveShellRuntime()` 返回 `{ executable, displayName, kind, syntax }`：
  - Windows：显式 `pwsh`/`powershell`/`cmd` 优先；否则先检测 PATH 中的 `pwsh`，再回退 `powershell.exe`。
  - macOS：`$SHELL` 是 bash/zsh/sh/dash/ksh 时使用；fish 等非 POSIX shell 回退 `/bin/zsh`。
  - 其他 POSIX：不可用时回退 `sh`。
- `buildShellInvocation()` 统一产出 executable 与参数：
  - POSIX：`shell -c command`。
  - PowerShell：编码前缀、可选 Job Object bootstrap、命令、退出码 trailer 放在同一条 `-Command` 脚本。
  - cmd：`/d /s /c command`。
- Shell 提示不再写死 PowerShell：
  - `describeShellSyntax()` 为 PowerShell 5.1、pwsh、cmd、POSIX 分别生成语法事实。
  - `RunCommand` 描述按当前 runtime 生成；Windows 命令长度上限从 64K 收到 30K，避免 `CreateProcess` 32K 限制。
  - coding 与 conversation 的环境上下文共用同一语法事实。
- 会话输出改为 `StreamingShellDecoder`：
  - 每个 stdout/stderr 持有独立 decoder，保留不完整 UTF-8 尾部。
  - 只有完整非法 UTF-8 才回退 GBK，并在该 stream 后续保持 GBK，避免逐 chunk 来回猜。
  - 会话快照按字符 offset 返回新增文本，不再按字节切片；关闭时 flush decoder。
- PowerShell stderr 包装清理只在 `syntax === "powershell"` 时执行，POSIX 与 cmd 原样保留 stderr。
- `Edit`：
  - 文件不存在 + `old_string=""`：新建。
  - 文件已存在、内容为空 + `old_string=""`：要求先 Read，再按原编码/BOM/行尾写回。
  - 文件非空 + `old_string=""`：继续拒绝。
- `ReadFileStateEntry` 增加可选 `contentHash`；Read 记录文本 SHA-256，Edit 在 mtime 变化时先比 hash，内容相同允许继续编辑。
- 仍不新增 `Write`、`Glob`、`WriteStdin`，也不新增第二个 shell 工具。

## 曾考虑的替代方案

- **为 Bash 与 PowerShell 各暴露一个模型工具：** 舍弃。模型不应先判断平台再选工具；一个 `RunCommand` 内部选 shell，契约更稳定。
- **完整照搬 OpenCode 的 Shell 工具：** 舍弃。OpenCode 的 Effect、权限、插件和多工具体系远超本轮范围；只借鉴 shell 检测、提示生成和进程终止思路。
- **继续写死 Windows PowerShell 5.1：** 舍弃。安装 `pwsh` 的用户会得到错误的语法提示和参数；检测成本很低。
- **每个 chunk 独立解码并回退 GBK：** 舍弃。UTF-8 多字节字符跨 chunk 时会被误判为非法；必须先留住不完整尾部。
- **自动猜测文件编码（GBK/GB18030）：** 暂不采用。无 BOM 文本的自动猜测会制造静默误写；文件和一次性输出仍 fail-closed，会话输出只做 UTF-8→GBK 的受控回退。
- **新增独立 Write 工具解决空文件：** 舍弃。用户已决定 Edit 兼顾新建；补空文件规则即可。

## 后果与防回退

- Windows 默认 shell 可能从 `powershell.exe` 变为 `pwsh`；提示与参数必须从同一个 `ShellRuntime` 读取，不能再按 `process.platform` 各自猜。
- 会话输出不再按字节切片；任何后续改动都必须保留“decoder 持有跨 chunk 状态”和“按字符 offset 出快照”这两个不变量。
- GBK 回退是 per-stream 的受控回退，不承诺 Big5、Shift-JIS 或同一 stream 中途切换编码；遇到其他编码仍可能显示替换字符。
- Edit 已存在空文件仍要求先 Read；这是防止并发覆盖的约束，不得为了“方便”去掉。
- `contentHash` 只在 Read 文本路径和 Edit 写回后记录；旧状态或文档路径没有 hash 时继续按 mtime/size 校验。
- 目录拆分（`text/`、`workspace/`、`builtin/<tool>/`）与 macOS CI 不在本次实施范围，保留在
  `docs/notes/proposed/architecture/2026-11-16-tool-runtime-portability-and-directory-contract.md`。

## 验证

- `pnpm typecheck` 通过（8 个 workspace 包）。
- `pnpm --filter @answra/agent test` 通过（584 项；含新增 shell decoder、会话 GBK、空文件 Edit、contentHash 假冲突测试）。
- `pnpm --filter @answra/cli test` 通过（305 项）。
- `pnpm lint`、`pnpm architecture:check`、`pnpm notes:check` 通过。
- `pnpm verify` 在 UI 全量测试的 `FloatingBarApp.navigation.test.tsx` 超时/找不到面板元素处中断；该文件单独重跑 9 项通过，属于既有并行测试抖动，与本次工具改动无关。
- 新增行为测试：
  - UTF-8 字符跨 chunk 不产生 U+FFFD；
  - 完整 GBK 字节流回退为中文；
  - 已存在空文件 Read 后可写入；
  - mtime 变化但内容相同允许 Edit；
  - PowerShell 5.1 / pwsh / macOS zsh / 非 POSIX `$SHELL` 的 runtime 解析。
- 未验证：真实 macOS 实机、macOS CI、目录迁移后的导入稳定性。

## 影响表面

- 模型可见工具不变，仍为 `Read`、`Grep`、`Edit`、`RunCommand`。
- Windows 用户安装 `pwsh` 后，`RunCommand` 的 shell 与提示会切换为 PowerShell 7+。
- 续接长命令的中文输出不再因 chunk 边界乱码。
- 已存在空文件可以在 Read 后通过 Edit 写入。
- CLI 与桌面端同时受影响，因为二者共用同一工具注册表。
