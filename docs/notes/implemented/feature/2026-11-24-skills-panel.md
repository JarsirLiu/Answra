# Note：CLI 的 `/skills` 目录面板

状态：已实施

## 问题

CLI 只有 Skill 工具调用卡片，没有浏览入口。用户无法在不触发模型的情况下确认当前会话到底能看到哪些 skill、它们来自工作区/用户/内置哪一层、同名 skill 最终由谁覆盖，也不知道空目录该去哪个路径找问题。Claude-Code 提供 `/skills` 面板集中展示来源分组；本仓库缺少对应能力。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/coding/host.ts`：`CodingHost` 新增 `listSkills()`，等待懒扫描完成后返回合并目录；未注入 `skillRoots` 时返回空数组。
  - `apps/cli/src/session/codingSession.ts`：新增 `CodingSkillSummary` 与 `CodingSession.listSkills()`，宿主不支持时返回空列表。
  - `apps/cli/src/adapters/agentCodingHost.ts`：把 `CodingHost.listSkills()` 映射为 CLI 会话端口。
  - `apps/cli/src/tui/panels/SkillsPanel.tsx`：按来源分组的只读列表，展示名称、描述、选中项完整描述与目录。
  - `apps/cli/src/tui/panels/panel.ts`、`panelHandlers.ts`：新增 `skills` 面板类型与 `loadSkills()`。
  - `apps/cli/src/tui/commands/catalog.ts`、`dispatch.ts`、`handlers/skill.ts`：新增 `/skills` 命令，`ALWAYS_AVAILABLE`，不接受参数。
  - `apps/cli/src/tui/app/App.tsx`：挂载面板。
- 测试：`apps/agent/test/coding/hostSkills.test.ts`、`apps/cli/test/tui/panels/skillsPanel.test.tsx`、`apps/cli/test/tui/runTui.test.ts`、`apps/cli/test/tui/commands/commands.test.ts`、`apps/cli/test/tui/tuiTestHarness.tsx`。
- UI/协议/持久化表面：只新增 CLI 展示与命令；skill 扫描、工具协议、事件与持久化不变。

## 影响表面

- 新命令 `/skills`：运行中也可打开，只读。
- 面板按「项目 skill → 用户 skill → 内置 skill」分组，组内保持目录扫描的按名称排序；同名覆盖规则由已有 catalog 决定，面板不重新合并。
- 选中行显示名称与单行描述；下方显示最多两行的摘要、来源中文标签和 skill 目录。
- 空目录显示空状态与排查提示；宿主读取失败显示错误而不是空列表。
- 未配置模型（没有活动会话）时命令提示先配置，不猜测默认 skill 目录。

## 决定

- 由 `CodingHost` 暴露 `listSkills()`，CLI 不重新扫描目录。重新扫描会复制来源解析与覆盖规则，且与模型实际可见的 catalog 可能分叉。
- 面板类型 `CodingSkillSummary` 留在 CLI `session` 包内，不把 `@answra/agent` 的 `SkillInfo` 类型透传到 TUI；adapter 负责字段映射。
- 面板只读：不提供「执行 skill」「删除 skill」动作。Skill 的调用由模型通过 `Skill` 工具完成，面板不应成为第二条执行路径。
- 分组顺序按覆盖优先级从高到低，而不是按字母排序，避免用户误判同名 skill 的来源。

## 曾考虑的替代方案

- **在 TUI 里直接调用 `@answra/agent` 的 `scanSkills`**：会绕过 host 已解析的 roots 与懒扫描结果，同名覆盖可能出现两套答案。
- **通过通知输出 skill 列表**：长列表会被输入框挤出视口，无法滚动和查看描述。
- **面板内支持 Enter 加载 skill/插入命令**：当前 CLI 没有显式 skill 调用命令，新增会创造与模型工具调用并行的执行语义。
- **展示 skill 正文预览**：列表需要快速浏览；正文已由 transcript 的 Skill 卡片通过 `ctrl+o` 提供。

## 后果与防回退

- `CodingHost` 的实现方必须提供 `listSkills()`；当前只有 `startCodingHost` 实现，新增宿主适配时不能返回伪造列表。
- 面板不复制 catalog 合并逻辑；来源分组只按 `SkillInfo.source` 过滤。来源词汇变化时需同步 `SKILL_GROUPS` 与类型。
- `/skills` 的 access 固定为 `ALWAYS_AVAILABLE`；若未来允许写操作，必须新增独立命令与 `idleOnly` 策略，不要给只读面板加隐式副作用。
- 空状态提示的是三类来源的通用位置，不打印猜测的绝对路径；需要精确路径时应扩展 `listSkills()` 返回 roots，而不是在 UI 里拼路径。

## 验证

- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm --filter @answra/cli exec vitest run test/tui/panels/skillsPanel.test.tsx test/tui/commands/commands.test.ts`：16 项通过，覆盖分组、焦点详情、滚动、空目录、加载失败与命令目录。
- `pnpm --filter @answra/cli exec vitest run test/tui/runTui.test.ts`：30 项通过，覆盖 `/skills` 打开面板与 `loadSkills()` 调用会话端口。
- `pnpm --filter @answra/agent exec vitest run test/coding/hostSkills.test.ts`：2 项通过，覆盖工作区扫描结果与无 roots 空列表。
- 实机验证（人工）：配置模型后运行 `/skills`，确认分组、选中项描述/目录与 Esc 关闭。
