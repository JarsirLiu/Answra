# Note：通用对话注入工作区系统上下文

状态：已实施

## 问题

通用对话已授权 `Read`/`Grep`，但工作区根目录只作为工具执行上下文存在（`runtime.setWorkspaceRoot` → `executeTurn` → `tools/workspace.ts`），从未进入模型提示词。模型只看到工具 schema，不知道工作区是什么、在哪里、当前是否已选择，也无法回答用户「工作区是什么」；未选择目录时仍会尝试调用必然失败的工具。

旧 Note `docs/notes/implemented/feature/2026-10-26-workspace-agent-read-tools.md` 明确「目录树不注入 prompt」，本 Note 只补充根目录事实，不恢复目录树注入。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/turn/workspaceContext.ts`（新增）、`executeTurn.ts`、`apps/agent/src/conversation/README.md`
- UI/进程/协议/持久化表面：不改 IPC 与持久化；工作区根目录仍由 desktop 在每次发送前通过 `workspace-context` 下发。
- 相关 Note：`docs/notes/implemented/feature/2026-10-26-workspace-agent-read-tools.md`

## 决定

- 每次 run 组装 system prompt 时，从本回合快照的 `workspaceRoot` 生成 `# 工作区` 段，追加到 profile 系统提示词之后；该段不持久化，不进入 transcript。
- 已选择目录：给出根目录绝对路径，声明它是默认根目录而非访问边界，`Read`/`Grep` 也接受任意绝对路径；优先在当前工作区查找，并要求需要文件信息时用 `Grep` 检索、不得臆测文件名。
- 未选择目录：声明 `Read`/`Grep` 仍可用但必须提供绝对路径，并建议用户先在「笔记本」面板选择目录以使用相对路径和默认搜索范围。
- 只有授权了工具的 profile 才注入该段；截图答题 profile 不携带工作区事实。
- 更换目录无需额外通道：desktop 在每次发送前重新下发 `workspace-context`，`executeTurn` 按 run 快照生成提示词，所以下一条消息即使用新目录；运行中的回合不追改。

## 影响表面

- 通用对话的模型请求新增一段工作区系统提示，包含本机工作区绝对路径；该路径会随请求发送给用户当前配置的模型服务。
- 用户换目录后，下一条对话消息即可正确说明新工作区；不会保留旧目录。
- 截图答题、面试自动回复的提示词与工具授权不变（面试复用通用 profile 时同样按发送前的根目录快照）。

## 曾考虑的替代方案

- **把目录树或文件清单拼进 prompt：** 舍弃。上下文体积不可控且难以审计模型实际访问内容，沿用旧 Note 的拒绝结论；文件发现交给 `Grep`，需要结构化枚举时再单独立项。
- **新增 `List`/`Glob` 工具：** 暂缓。它属于文件发现能力，需要单独的资源边界与测试策略，不与本次「让模型知道工作区是什么」混做。
- **把根目录写进静态 profile 提示词：** 舍弃。根目录可在会话期间变化，静态提示会持续撒谎。
- **保持原状，让模型从工具报错中学习：** 舍弃。模型会先无效调用工具，且仍无法回答「工作区是什么」。
- **未选目录时不向模型暴露 `Read`/`Grep` schema：** 暂缓。当前工具授权只按 profile 静态判定，按可用性裁剪工具会把「工作区是否就绪」耦合进通用工具装配；本次先用明确的提示词约束，若实测仍出现无效调用再评估。

## 后果与防回退

- 工作区事实只能来自 run 快照的 `workspaceRoot`；不得在 profile 写死路径，也不得从 renderer 接受任意 prompt。
- 未选择目录的提示语与已选择目录的路径规则必须与 `core/tool/builtin/workspace.ts` 的实际行为一致；工作区语义变化时同步更新该提示词及其测试。
- 绝对路径暴露给模型是本次有意接受的代价（与 WeCode 的 environment 段一致）；提示词不得扩展到文件内容或目录树。
- 新增会读取工作区的工具时，必须同时确认该提示词是否仍准确。

## 验证

- `apps/agent/test/conversation/turn/workspaceContext.test.ts`：已选目录包含根目录、默认根语义与绝对路径规则；未选目录要求绝对路径且不再声明工具不可用。
- `apps/agent/test/conversation/application.test.ts` 新增用例：根目录 A → 根目录 B → 未选择依次出现在对应请求中，且答题 profile 不包含工作区块。
- 命令：`pnpm --filter @answra/agent exec vitest run test/conversation/turn/workspaceContext.test.ts test/conversation/application.test.ts`（23 项通过）。
- `pnpm verify`：Biome、全包 typecheck、全包测试与架构检查全部通过。
- 真实模型 function calling 与「更换目录后实机问答」尚未验收；自动化只证明请求包含预期系统上下文。
