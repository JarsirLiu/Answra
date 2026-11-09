# Note：Read 工具文本读取质量对齐

状态：已实施

## 问题

`Read` 迁移到 `core/tool/builtin` 后仍沿用早期 MVP：只接受工作区相对路径、只允许固定扩展名、单文件上限 128 KiB，空文件会返回 `1\t`，大文件由执行器静默截断，模型拿不到“内容被截断、下一段从哪里开始”的明确提示。与 ZCode 的文本读取能力相比，这些差异会直接影响模型读取工作区的可靠性。

本次把 `Read` 的文本子集提升到可日常使用的程度：结构化输出、25k token 预算、部分视图、文件状态去重、缺失文件建议、UTF-8/UTF-16 解码，并修正执行器对结构化输出的字节上限检查。`Grep` 的后续 ripgrep 改造见 `2026-11-09-grep-ripgrep-tool.md`。

## 涉及范围

- `apps/agent/src/core/tool/builtin/read.ts`：路径、文件状态、缺失文件建议、错误归一和 Read 工具装配。
- `apps/agent/src/core/tool/builtin/readOutput.ts`：`ReadOutput` 类型、25k token 估算、部分视图和模型可见投影。
- `apps/agent/src/core/tool/builtin/workspace.ts`：工作区绝对/相对路径、UTF-8/UTF-16 BOM、二进制预检、文件 stat 与读取上限。
- `apps/agent/src/core/tool/contracts.ts`、`registry.ts`、`index.ts`：按会话共享的 `ReadFileStateMap`。
- `apps/agent/src/conversation/agent.ts`、`application.ts`：把会话级 Read 状态注入工具授权上下文，并在清空会话/销毁时清理。
- `apps/agent/src/core/tool/executor/executeToolCall.ts`：`maxOutputBytes` 改为检查 `formatModelContent` 之后的模型可见内容。
- `apps/agent/test/core/tool/builtinTools.test.ts`、`executeToolCall.test.ts`：新增文本子集行为测试。
- `docs/notes/implemented/architecture/2026-11-09-agent-tool-system-foundation.md`：同步 `maxOutputBytes` 检查时机。
- `docs/notes/implemented/feature/2026-10-26-workspace-agent-read-tools.md`：保留历史背景，由本 Note 记录后续质量调整。

## 影响表面

- 模型可读取工作区内任意 UTF-8/UTF-16 纯文本文件，包括无扩展名文件和常见源码/配置；不再受固定扩展名白名单限制。
- 模型可使用工作区相对/绝对路径以及工作区外路径；工作区只是相对路径基线。版本库目录仍被拒绝，符号链接经 `realpath` 后按目标路径判断。普通点文件（如 `.env`）可读取。
- 默认读取全文；内容超过 25k token 时返回带行号的部分视图、已显示范围和下一 `offset`，模型可继续分段读取。空文件、越界 offset、缺失文件和相似文件名都有明确提示。
- 同一会话内重复读取相同范围且文件未变化时返回 `file_unchanged`，避免模型重复消耗上下文。
- 工作区正文仍会发送给当前配置的模型服务；本次不改变 UI、IPC、worker 协议或持久化表面。

## 决定

- `file_path` 同时接受工作区相对路径和任意绝对路径；两者都经过 `realpath`，只按真实路径的目录段排除版本库目录，不要求落在工作区内。工作区外路径策略见 `../architecture/2026-11-09-workspace-default-root-not-boundary.md`。
- 不再用扩展名白名单判断文本：读取字节后按 BOM 识别 UTF-8/UTF-16LE/UTF-16BE，否则执行二进制控制字符预检并严格 UTF-8 解码。不引入 `iconv-lite`，GBK 等遗留编码仍不支持。
- `Read` 单文件上限 256 KiB；带 `offset`/`limit` 的范围读取允许读到 16 MiB 扫描上限，避免大文件只能整文件拒绝。
- 空文件返回 `<system-reminder>文件存在，但内容为空。</system-reminder>`，不再输出 `1\t`。
- offset 超出文件行数时返回文件总行数与越界说明。
- token 估算与 ZCode 文本子集一致：中文字符按两个字符计入，除数 3；上限 `25_000`，部分视图目标为上限的 85%。超过上限且是首次全文读取时返回部分视图；显式范围读取超限时返回 `output-too-large`，要求模型缩小范围。
- `Read` 现在返回结构化 `ReadOutput`（`text` / `file_unchanged`），由 `formatModelContent` 投影成模型文本。输出 schema 仍未落地，本次不伪造运行时校验。
- Read 状态按会话保存 `path + offset + limit` 键、mtime 和文件大小；partial view 不参与 `file_unchanged`，避免把不完整视图当成完整读取。状态在当前进程内存中，不持久化，会话清空/应用销毁时释放。
- `maxOutputBytes` 改为检查模型投影后的内容。结构化 output 的 JSON 包装不应误触发 `output-too-large`，真正发给模型的内容才受字节上限约束。

## 曾考虑的替代方案

- **完整照搬 ZCode Read：** 舍弃。图片/视频/PDF/notebook、文件状态元数据持久化、输出 schema 校验和 ZCode 文件系统端口需要新的依赖、端口与跨调用状态；本轮先完成文本子集。
- **保留扩展名白名单：** 舍弃。模型需要读取无扩展名文件和更多源码/配置格式；白名单会制造静默不可读文件。UTF-8/UTF-16 与二进制预检更接近真实边界。
- **只接受相对路径：** 舍弃。模型和 ZCode 习惯使用绝对路径；在工作区内接受绝对路径不降低安全性，边界仍由 `realpath` 保证。
- **大文件直接报错：** 舍弃。返回可继续读取的部分视图能让模型自行分段，不需要再次猜测 offset。
- **让执行器统一截断：** 舍弃。执行器只能给出“已截断”标记，无法告诉模型下一段 offset；Read 自己生成部分视图更可操作。
- **引入 zod/iconv-lite 一次性补全 ZCode：** 舍弃。当前工具契约不引入 zod，GBK 也不是已确认需求；先保持依赖面不变。
- **把 read 状态放在 registry 全局 Map：** 舍弃。按 `sessionId` 的全局缓存需要额外清理责任；当前由 `ConversationApplication` 显式持有并在清空/销毁时释放。

## 后果与防回退

- 正面后果：Read 对绝对/相对路径、无扩展名文本、UTF-8/UTF-16、空文件、缺失文件和越界范围的反馈稳定；大文件可以被模型分段读取，重复读取不再浪费上下文。
- 代价：Read 会读取任意受支持编码的文本文件，不再按扩展名预筛；安全边界仍依赖工作区路径校验和版本库目录排除。会话级 read 状态只存在内存中，进程重启后失效。
- 防回退：
  - 不得恢复扩展名白名单作为 Read 的唯一准入条件。
  - 不得让空文件返回空字符串或伪造行号。
  - 部分视图必须同时给出已显示范围和下一 offset。
  - 版本库目录仍然拒绝；不能因为支持工作区外路径而取消 `realpath` 后的 VCS 排除。
  - `partialView` 的读取结果不得返回 `file_unchanged`。
  - `maxOutputBytes` 必须检查模型投影结果，不得回退到原始 JSON 序列化。
  - `Grep` 已由 `2026-11-09-grep-ripgrep-tool.md` 升级为 WASI ripgrep；不得回退为字面搜索。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent test`：27 个测试文件、193 个测试通过。
- `pnpm exec vitest run test/core/tool/builtinTools.test.ts test/core/tool/executeToolCall.test.ts test/core/tool/registry.test.ts test/core/tool/grep.test.ts test/conversation/turn/workspaceContext.test.ts`：47 个测试通过。
- 覆盖：工作区绝对/相对路径、工作区外相对/绝对路径与符号链接目标、无 workspace 的绝对路径、`Dockerfile` 无扩展名文本、空文件提示、offset 越界、默认全文读取、25k token 部分视图、单行超 token 预算、256 KiB 整文件上限与范围读取、`file_unchanged`、缺失文件相似名建议、UTF-16 BOM、二进制拒绝、版本库路径拒绝、取消、结构化输出投影后的字节上限。
- 实机验证待桌面端真实对话中触发 Read 后补录；自动化验证只覆盖 Agent 进程内的工具行为。
