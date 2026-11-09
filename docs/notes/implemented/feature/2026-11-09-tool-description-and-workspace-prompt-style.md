# Note：工具描述与工作区提示避免能力播报

状态：已实施

## 问题

`Read`/`Grep` 的主描述是较长的中文能力说明，包含“读取 UTF-8/UTF-16 纯文本”“支持 glob、type、-A/-B/-C……”等实现细节；工作区系统提示又直接点名 `Read` 和 `Grep`，并列举“读取文件 / 搜索内容”。模型会把提示词里的能力清单当成可复述内容，回答成“我可以使用 Read 读取文件，或用 Grep 搜索，甚至能读 UTF-8”，看起来像在念工具说明书，而不是直接完成任务。

ZCode 的写法更克制：工具主描述只说明何时使用和关键规则，参数说明放在 schema 的 `description`，系统提示只提供环境事实。用户明确要求按这个方向调整。

## 涉及范围

- `apps/agent/src/core/tool/builtin/read.ts`：`Read` 主描述与 `file_path`/`offset`/`limit` 参数说明。
- `apps/agent/src/core/tool/builtin/grep.ts`：`Grep` 主描述与全部参数说明。
- `apps/agent/src/conversation/profiles/registry.ts`：通用聊天系统提示不再点名工具或列举能力。
- `apps/agent/src/conversation/turn/workspaceContext.ts`：工作区段只保留环境事实和路径规则。
- `apps/agent/test/conversation/turn/workspaceContext.test.ts`：防止工作区提示重新出现工具能力播报。
- 相关 Note：`2026-11-07-conversation-workspace-system-context.md`、`2026-11-09-grep-ripgrep-tool.md`、`2026-11-09-read-tool-text-quality.md`。

## 影响表面

- `Read` 主描述改为短英文规则：读取文本、路径、默认全文/部分视图、行号格式、错误与避免重复读取；不再在主描述里提 UTF-8/UTF-16。
- `Grep` 主描述改为短英文规则：ripgrep 正则、glob/type、output_mode、path、multiline；`-A/-B/-C`、`-n`、`-i`、`-o`、`head_limit`、`offset` 等说明进入参数 schema。
- 通用聊天系统提示只说“涉及文件或目录内容时先查看实际内容，不要猜测，优先工作区”，不再说 `Read`/`Grep` 能做什么。
- 工作区系统上下文不再出现 `Read`/`Grep` 工具名或“可以读取/可以搜索”的能力清单；已选目录与未选目录的路径规则保持不变。
- 工具行为和错误文案不变；聊天 UI 仍可正常显示工具调用。

## 决定

- 工具主描述采用 ZCode 的短规则风格，使用英文，只写使用时机和关键约束；参数语义写在 JSON Schema 的 `description`，避免主描述承担完整 API 文档。
- `Read` 不宣传编码实现：文本编码是内部边界，不在模型可见主描述里强调；遇到非文本文件返回现有错误。
- `Grep` 保留“这是 ripgrep 正则而非普通 grep”这一必要语义，避免模型把正则当字面量；不再在主描述逐个展开所有参数。
- 系统提示不枚举工具能力。模型看到工具 schema 自然会知道可调用；提示词只补充工作区路径事实和“先读后答”的行为约束。
- 工作区上下文测试增加断言：输出不得出现 `Read`/`Grep` 工具名，防止能力播报回归。

## 曾考虑的替代方案

- **把 ZCode 描述逐字翻译成中文：** 舍弃。当前问题不是语言本身，而是主描述混入实现细节和参数手册；保留 ZCode 的英文短描述并下沉参数说明更直接。
- **只改系统提示，保留原工具描述：** 舍弃。模型仍会从工具描述里看到“UTF-8/UTF-16”和“支持 …”清单，能力播报仍有来源。
- **只改工具描述，保留系统提示点名：** 舍弃。系统提示直接列出 `Read`/`Grep` 能力，模型仍会复述；两处都需要收敛。
- **完全删除工具描述：** 舍弃。模型需要知道何时调用、路径和 output_mode 语义；参数 schema 也不能替代主描述的调用时机。
- **把工具名改成中文“读取/搜索”：** 舍弃。会改变工具调用名和 UI 显示，且不能解决能力清单被复述的问题。

## 后果与防回退

- 正面后果：工具元数据更短，模型回答更少复述“我能做什么”，更倾向直接读取或搜索；参数说明仍在 schema 中，不影响调用正确性。
- 代价：英文工具描述与中文系统提示混用；若未来 provider 对描述语言敏感，需要实机对比，但不能因此恢复实现细节长文。
- 防回退：
  - 工具主描述不得重新写入编码类型、内部限制或完整参数手册。
  - 参数语义必须继续放在 schema 的 `description`，不能只靠主描述。
  - 工作区系统提示不得点名 `Read`/`Grep` 或列举“能读取/能搜索”等能力。
  - 新增工具时先写短使用规则和参数说明，不得把系统提示扩成工具目录。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent test`：27 个测试文件、193 项通过。
- `pnpm exec vitest run test/conversation/turn/workspaceContext.test.ts test/core/tool/builtinTools.test.ts test/core/tool/grep.test.ts`：3 个测试文件、27 项通过。
- `workspaceContext.test.ts` 新增断言：已选/未选工作区提示均不出现 `Read`/`Grep` 工具名。
- `pnpm lint`：通过。
- 真实模型回复是否仍出现能力播报需在桌面端重新对话验收；自动化只能约束提示词和工具元数据内容。
