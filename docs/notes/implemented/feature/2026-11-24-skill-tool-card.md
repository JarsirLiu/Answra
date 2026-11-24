# Note：CLI 的 Skill 工具卡片

状态：已实施

## 问题

CLI transcript 里 `Skill` 调用落到 fallback presenter：标题显示成 `Skill(Skill)`，展开内容是原始 `{"name":"answra-code"}` 输入和带 `<skill_content>` 包装的 Markdown 正文，折叠态还会先露出两行正文再加 `+165 lines`。用户无法从标题看出加载的是哪个 skill，也看不出加载了多少内容。

参考实现（`D:\codespace\Claude-Code` 的 `SkillTool/UI.tsx`）把工具调用收成一行：调用侧只显示 skill 名，结果侧显示一句 `Successfully loaded skill` 及可用工具数/模型，正文不进入 transcript。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/coding/host.ts`：暴露当前宿主已扫描的 skill 目录，CLI 面板复用目录结果而不重复扫描。
  - `packages/ui/src/tool-presentation/registry.ts`：新增 `Skill` 规范工具名，接受 `skill` / `skill.load` 别名。
  - `packages/ui/src/tool-presentation/tools/skill.ts`：新增 presenter，解析 `name`、正文行数、附件数与截断标记。
  - `packages/ui/src/tool-presentation/present.ts`、`types.ts`：注册 presenter，新增 `skill` 分类。
  - `apps/cli/src/presentation/toolLabels.ts`：`Skill` 的非 TTY 标签。
  - `apps/cli/src/tui/transcript/tool/ToolDetails.tsx`：`skill` 与 `search` 一样，正文只在展开时渲染。
- 测试：`packages/ui/test/toolPresentation.test.ts`、`apps/cli/test/presentation/toolLine.test.ts`、`apps/cli/test/tui/transcript/tool/tui.toolPresentation.test.tsx`。
- UI/协议/持久化表面：只影响 CLI 的工具展示；工具输入/输出、事件、条目与持久化格式不变。

## 影响表面

- 折叠态：`Skill(answra-code)` + `⎿ Loaded 165 lines · 2 files` + `ctrl+o to expand`，不再显示正文。
- 展开态：显示去掉 `<skill_content>`、重复标题、base directory 与 `<skill_files>` 包装后的正文，仍受既有详情行数/字符预算限制。
- 非 TTY：开始行从 `Skill(Skill)` 变为 `Skill(answra-code)`；结束行仍为 `Skill ok Nms`。
- `Skill` 加载失败或未知 skill 时仍走错误文案，不伪造成功摘要。

## 决定

- 在 `@answra/ui/tool-presentation` 增加专用 presenter，而不是在 CLI 里按工具名特判；桌面与其他宿主以后复用同一展示语义。
- 标题只放 skill 名（`primary`），加载统计放 `resultLine`；正文放 `details`，并新增 `skill` 分类让折叠态隐藏正文。
- 统计只从工具输出解析，不新增事件字段：正文行数、`<file>` 数、`Note: content truncated`。输出不是包装格式时按普通文本处理，不猜测来源。
- 未展示 skill 来源（工作区/内置/用户）：当前输出不含来源，UI 不为展示另开工具协议字段。

## 曾考虑的替代方案

- **只给 fallback 改标题**：仍会把原始 JSON 和 Markdown 塞进折叠态，等于没解决可读性。
- **在 CLI 里特判 `part.toolName === "Skill"`**：绕过共享展示层，桌面与后续宿主需要各写一遍，且测试只能覆盖单端。
- **让 Skill 工具返回结构化 UI 字段（来源、行数等）**：需要新增输出契约与条目字段，当前展示所需信息已能从既有输出解析，不值得为 UI 扩大工具协议。
- **完全隐藏正文、不提供展开**：用户有时需要确认 skill 实际内容；保留 `ctrl+o` 与既有详情预算即可。

## 后果与防回退

- 新增 `CanonicalToolName` 与 `ToolCategory` 成员，任何 `Record` 穷举（label、presenter）必须同步补齐；类型检查会拦截遗漏。
- `ToolDetails` 的折叠隐藏规则现在按分类集合维护；新增需要折叠隐藏正文的分类时改这一处，不要在组件里加工具名判断。
- 正文解析依赖 `formatSkillOutput` 的包装文本；若包装格式变化，presenter 会退回整段文本展示而不是崩溃，但仍应同步更新解析与测试。
- `Loaded … lines` 统计的是正文行数，不含包装与 base directory；不要拿它和 `Read N lines` 的语义混用。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/toolPresentation.test.ts`：17 项通过，覆盖名称解析、正文行数/附件数、running 无结果行、截断标记。
- `pnpm --filter @answra/cli exec vitest run test/presentation/toolLine.test.ts test/tui/transcript/tool/tui.toolPresentation.test.tsx`：14 项通过，覆盖非 TTY `Skill(answra-code)` 与 TUI 折叠/展开。
- `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/cli typecheck`、`pnpm exec biome check`：通过。
- 实机验证（人工）：CLI 中调用 `Skill({ name: "answra-code" })`，折叠行应显示 skill 名与加载统计，展开后才出现正文。
