# Note：工作区 skill 在子目录启动时不可见

状态：已实施

## 问题

在 `apps/cli` 下启动 `answra code` 后，模型按仓库根 `AGENTS.md` 的指引调用 `Skill({ name: "answra-arch" })`，工具返回「没有可用的 skill，无法加载「answra-arch」」。但 `D:\codespace\exam-assistant\.agents\skills\answra-arch\SKILL.md` 确实存在，且 `AGENTS.md` 是同一个会话里加载进来的。

同一现象在任意"仓库根有 `.agents/skills`、从子包目录启动"的组合下都能复现。

## 涉及范围

- 代码/模块：
  - 新增 `apps/agent/src/core/workspace/projectRoot.ts`：项目根发现，instruction 与 skill 共用。
  - `apps/agent/src/core/skill/contracts.ts`：`SkillRoots.workspace` 改为 `workspaceRoot`。
  - `apps/agent/src/core/skill/catalog.ts`：工作区来源向上逐层扫描 `.agents/skills`；`SkillCatalog` 暴露扫描来源。
  - `apps/agent/src/core/instruction/catalog.ts`：改用共享项目根发现，行为不变。
  - `apps/agent/src/core/tool/builtin/skill/tool.ts`：空 catalog 报错列出三类来源。
  - `apps/cli/src/config/skillRoots.ts`：注入工作区根；源码运行时回退解析 `@answra/skills`。
  - `apps/agent/src/coding/policy.ts`：coding Bot 的 skill 名单补上 `answra-arch`。
  - `apps/desktop/src/main/conversation/workerTransport.ts`：跟随 `SkillRoots` 字段改名。
- 测试：`apps/agent/test/core/skill/catalog.test.ts`、`skillTool.test.ts`、`skillIndexIntegration.test.ts`，新增 `apps/cli/test/config/skillRoots.test.ts`。
- UI/进程/协议/持久化表面：不改 worker 线协议、不改 transcript 与数据库；只有 system prompt 的 skill 索引内容随可见范围变化。
- 相关 Note：[Agent Skill 目录扫描与按需加载](../../proposed/architecture/2026-11-17-agent-skill-catalog-and-loading.md)。

## 决定

- `SkillRoots.workspaceRoot` 只表示工作区根；工作区来源的 `.agents/skills` 由 agent 从工作区根向上到项目根逐层发现，宿主不再自行拼接。
- 项目根规则与 `AGENTS.md` 完全一致（最近的 `.git`），抽到 `core/workspace/projectRoot.ts` 供两者共用。
- 同名覆盖顺序固定为：工作区近层 > 工作区远层 > 用户 > 内置。
- 空 catalog 的 `Skill` 工具错误必须列出三类来源；源码运行的内置 skill 通过 `@answra/skills` 依赖解析。
- 不做递归全盘扫描，也不新增环境变量覆盖来源。

## 根因

`SkillRoots.workspace` 在宿主侧被解析成"工作区根下的 `.agents/skills` 目录"（`apps/cli/src/config/skillRoots.ts`），而 `createLazySkillCatalog` 的 `setWorkspaceRoot` 又把入参当作"工作区根"再拼一次 `.agents/skills`。同一个字段承载了两种语义，发现范围只在宿主解析一次，且固定为 cwd 那一层。

同时，`AGENTS.md` 的发现规则是"从当前工作区向上找到最近的 `.git` 作为项目根，逐层加载"。两条发现链范围不同：指令能看到仓库根 `AGENTS.md` 及其中的 skill 引用，skill 索引只扫 cwd 一层。从子包目录启动时，catalog 为空，`Skill` 工具只能返回空目录提示。

此外，源码运行（`tsx`）时内置 skill 根指向 `apps/cli/src/config/skills`（不存在），只有打包后才有 `dist/skills`；空 catalog 的错误文案也不说明扫了哪些根，用户只能靠猜。

## 修复

- `SkillRoots.workspaceRoot` 明确表示"工作区根"，agent 负责从它向上到项目根逐层拼出 `<dir>/.agents/skills`。
- 新增 `core/workspace/projectRoot.ts` 提供 `findProjectRoot` 与 `discoverProjectDirectories`；instruction 与 skill 共用同一套 `.git` 边界规则。没有 `.git` 时只返回起始目录，不读工作区之外的父目录。
- 工作区来源按"最近 → 项目根"顺序扫描：近层同名 skill 覆盖远层，工作区整体仍覆盖用户与内置。
- `SkillCatalog.roots()` 返回扫描时使用的来源，`Skill` 工具在空 catalog 时报错里列出内置、用户、工作区三类来源。
- CLI 源码运行时用 `@answra/skills` 包目录兜底内置根；打包后仍优先 `dist/skills`。
- coding Bot 的 skill 名单补上 `answra-arch`：`AGENTS.md` 已把它列为架构改动必读，漏配会让模型看得到指引、索引里却看不到这条 skill。

## 曾考虑的替代方案

- **只要求用户从仓库根启动或使用 `--cwd`：** 舍弃。这是真实使用场景（在子包里跑 `pnpm dev`），要求用户记住工作区根与启动目录必须一致不是修复，且 desktop 侧同样存在子目录工作区。
- **宿主算好项目根下的 skill 目录再注入，保持单目录契约：** 舍弃。desktop 的工作区由 `workspace-context` 命令在运行时下发，宿主启动时并不知道；把向上发现放在宿主还要再改线协议。只取项目根也会丢掉子包自己的 `.agents/skills`。
- **递归扫描工作区下所有 `.agents/skills`：** 舍弃。会进入 `node_modules`、构建产物等无关目录，扫描范围与耗时都不可控。
- **新增 `ANSWRA_SKILLS_DIR` 环境变量：** 舍弃。增加配置面却不改变默认行为，用户仍需显式配置才能看到本仓库 skill。
- **只改错误文案说明"没有可用 skill"：** 舍弃。文案只能解释失败，不能让仓库 skill 真正可加载。

## 后果与防回退

- 工作区 skill 的发现边界止于最近的 `.git`；没有 `.git` 时只看工作区根。不得改成无限向上或递归全盘。
- 同名覆盖顺序固定为：工作区近层 > 工作区远层 > 用户 > 内置。
- `setWorkspaceRoot` 的入参仍是工作区根，不是 skill 目录；宿主不得再自行拼 `.agents/skills`。
- 空 catalog 的错误必须带上三类来源；不得退回无诊断信息的「没有可用的 skill」。
- `AGENTS.md` 与 skill 必须继续使用同一项目根规则；新增第三种发现范围前先统一到 `core/workspace/projectRoot.ts`。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/skill test/core/instruction`：7 个测试文件、55 项通过，覆盖工作区根扫描、向上到项目根、近层覆盖、越过 `.git` 不读父目录、`setWorkspaceRoot` 重扫与空 catalog 来源诊断。
- `pnpm --filter @answra/cli exec vitest run test/config/skillRoots.test.ts`：3 项通过，确认源码运行可解析到 `@answra/skills`，且工作区根原样传递。
- 在 `apps/cli` 下用宿主解析函数与 `scanSkills` 实测：结果为 `answra-arch/answra-change/answra-code/answra-vision` 四个工作区 skill 加内置 `resume-rewrite`，修复前同一目录返回空目录。
- `pnpm --filter @answra/cli build` 与 `node dist/main.mjs --help`：打包产物可用，内置目录仍从 `dist/skills` 解析。
- `pnpm exec biome check`、`pnpm architecture:check`、`pnpm lint`：通过。
- 实机验证（人工）：在 `D:\codespace\exam-assistant\apps\cli` 启动 CLI，新会话调用 `Skill({ name: "answra-arch" })` 应返回正文，而不是空目录提示。
