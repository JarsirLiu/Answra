# Note：CLI `/config` 模型 ID 改为行内直接编辑

状态：已实施

## 问题

`/config` 的 Chat/Answer 模型行按 `Enter` 后进入模型子菜单或 `/model` 选择器，而不是像 Base URL、API Key 一样在当前行展开输入框。模型目录只有当前模型时，面板里没有可见的“编辑模型 ID”入口；用户只能离开 `/config` 使用 `/model <ID>`。

Claude Code 的 `/config` 确实复用 `ModelPicker`，但它的模型集合相对固定，任意模型名走 `/model <modelName>`。Answra 面向大量 OpenAI 兼容端点，模型 ID 经常不在 `/models` 列表中，不能照搬“只能选列表”的交互。

同时，本地 `apps/cli/dist/main.mjs` 在本次源码改动前构建，实际运行看到的仍是旧的 `Select model` 面板；源码修复必须重新构建 CLI 才会生效。

## 涉及范围

- `apps/cli/src/tui/commands/ConfigPanel.tsx`：Chat/Answer 模型行与文本字段一样进入行内 `PromptInput`，删除模型子菜单状态。
- `apps/cli/src/tui/commands/ConfigList.tsx`：复用现有行内编辑器，Chat/Answer 显示模型 ID 编辑提示。
- `apps/cli/src/tui/commands/configPresentation.ts`：选中模型行时 footer 明确提示“编辑模型 ID”。
- `apps/cli/src/tui/app/App.tsx`：`/config` 不再注入 `loadModels`；`/model` 仍使用模型目录。
- `apps/cli/src/tui/commands/ConfigModelMenu.tsx`：删除。
- `apps/cli/test/tui/commands/configPanel.test.tsx`：覆盖 Chat/Answer 行内直接编辑、清空 Answer、保存。
- `apps/cli/test/tui/commands/configPresentation.test.ts`：footer 文案。
- `apps/cli/src/tui/commands/ModelPicker.tsx`：保留列表选择与 `Tab` 手动输入，供 `/model` 使用。

不涉及模型目录 HTTP、配置持久化、Agent 运行时或 `/model <ID>` 的直接切换语义。

## 决定

- `/config` 的 Chat/Answer 模型行按 `Enter`/`→` 直接展开行内输入框，不再跳转 `/model` 或嵌入模型子菜单。
- 模型 ID 是普通文本字段，可直接覆盖任意值；Answer 留空仍表示与 Chat 相同。
- 模型列表仍由 `/model` 提供；`/model` 继续支持列表、`Tab` 手动输入和 `/model <ID>`。
- `/config` 保存仍只经过既有 `save` 端口，不在 TUI 内直接写配置。
- 删除 `ConfigModelMenu`，避免保留两套模型编辑入口和重复的滚动状态。

## 根因

`ConfigPanel.openField()` 对 `chatModel`/`answerModel` 特殊处理：先设置 `submenu`，只有子菜单内的手动项或 `/model` 才能编辑模型名。配置列表本身没有把这两个字段当作可编辑文本，导致用户看到当前值却找不到输入框。

额外问题是运行产物 `apps/cli/dist/main.mjs` 早于源码修改，截图中的 `Select model` 是旧 bundle 的行为。

## 修复

- `ConfigPanel` 删除 `submenu` 状态、`loadModels` prop 与 `ConfigModelMenu` 渲染；所有字段统一调用 `setEditing(field)`。
- `ConfigList` 继续使用 `PromptInput`，Chat/Answer 的 `editorHint()` 已提供模型输入提示。
- `configPanelFooter` 删除子菜单分支，选中模型行时提示 `Enter/→ 编辑模型 ID`。
- `App.tsx` 仅向 `/model` 注入 `loadModels`。
- 更新测试：不再断言模型子菜单，改为断言行内编辑、不出现 `Select model`、保存输入正确。

## 曾考虑的替代方案

- **保留 `/config` 模型子菜单，仅补手动输入：** 舍弃。用户仍要先打开选择器才能编辑，且视觉上仍像“跳到 /model”。
- **完全照搬 Claude Code 的 `ModelPicker`：** 舍弃。Claude Code 有稳定的模型集合和 `/model <name>` 命令；Answra 的自定义端点更依赖自由输入。
- **行内编辑 + `Tab` 打开模型列表：** 本次不做。`/model` 已经提供列表入口，配置面板再放一个隐藏快捷键会增加 footer 噪声；若后续需要可另加显式入口。
- **删除 `/model` 选择器：** 舍弃。列表、当前项和模型发现仍有价值，只是不再作为 `/config` 的唯一编辑路径。
- **保留 `ConfigModelMenu` 作为未使用组件：** 舍弃。会形成死代码和两套滚动/手动输入语义。

## 后果与防回退

- `/config` 四个字段现在都是同一种交互：`Enter`/`→` 行内编辑，`Ctrl+S` 保存。
- Chat/Answer 不再依赖 `/models`；目录不可用或列表不完整时仍可直接填写模型 ID。
- `/model` 仍负责列表选择，`Tab` 手动输入和 `/model <ID>` 保持可用。
- 防回退：`configPanel.test.tsx` 覆盖 Chat 行内编辑、Answer 清空、保存 payload，并断言不出现 `Select model`；`configPresentation.test.ts` 覆盖模型行 footer。
- 运行注意：修改源码后必须执行 `pnpm --filter @answra/cli build`（或使用 `pnpm dev:cli`）才能看到新交互；直接运行旧 `dist/main.mjs` 不会更新。

## 验证

- `pnpm --filter @answra/cli typecheck` 通过。
- `pnpm --filter @answra/cli test`：46 个测试文件、283 项通过。
- `pnpm --filter @answra/cli exec vitest run test/tui/commands/configPanel.test.tsx test/tui/commands/configPresentation.test.ts`：14 项通过。
- `pnpm --filter @answra/cli exec vitest run test/tui/commands/modelPicker.test.tsx`：5 项通过。
- `pnpm --filter @answra/cli build` 成功，`dist/main.mjs` 更新为 2026-11-16 构建。
- `pnpm notes:check` 通过；`pnpm exec biome check` 检查相关 CLI 文件通过。
- `pnpm architecture:check` 在最终提交前执行。
