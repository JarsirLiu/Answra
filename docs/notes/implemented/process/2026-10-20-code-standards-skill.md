# Note：代码工程规范 skill（answra-code）

状态：已实施

## 问题

AI 与新协作者产出的代码出现系统性质量病灶：不看架构往最容易的位置堆代码、契约靠 `unknown`/字符串蒙混过关、防御性代码层层堆砌（下游 type guard 复述类型系统、catch-all 静默兜底）、魔法值散落、一个概念散在多个文件。AGENTS.md 只有结构约定，既有 skill（answra-change/answra-vision/answra-submit）分别覆盖流程、方向和提交收尾，**没有覆盖"怎么把代码写对"**。

## 涉及范围

- 代码/模块：`.agents/skills/answra-code/SKILL.md` 新增；`AGENTS.md` 质量门禁章节增加指针行。
- 流程表面：不改变任何代码、命令或 CI 行为；为写代码与评审注入判断框架和自查清单。
- 相关 Note：[提交前 AI 自检 skill](../../archived/process/2026-10-20-ai-submit-self-check-skill.md)、[产品方向与 Agent 底座提案](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)、[面试语音运行时模块边界](../../proposed/architecture/2026-10-19-interview-runtime-module-boundaries.md)、[对话与答题领域拆分](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 流程变化

- 写代码时先执行"三个判断"：代码属于哪层（shared/ui/desktop/agent core/领域）、契约最远传多远（跨进程先落类型）、端口由谁注入。
- 增加防御性代码预算概念：校验只发生在世界边界（IPC/HTTP/文件），核心信任类型；catch-all 与静默兜底列为禁令；fail-closed 优先于静默降级。
- 修订从既有仓库实践提炼的榜例：branded id 工厂（`contracts.ts`）、命名常量（`PCM_FRAME_MAX_SAMPLES`）、一文件一职责顶注（`protocol.ts`）、稳定错误码表、单 writer 状态、契约先行测试。
- 新增"提交前自查十问"（后续随 [`answra-code` 定稿](2026-10-20-answra-code-rewrite.md) 演化为十四问，并收编原 `answra-submit` 的提交检查；见归档 [提交前 AI 自检 skill](../../archived/process/2026-10-20-ai-submit-self-check-skill.md)）。

## 决定

规范固化为一等 skill（`answra-code`），触发场景覆盖"写、改、评审任何 TS/TSX"。规范必须引用本仓库真实榜例，禁止泛泛的最佳实践口号，使 AI 对照的是本仓库已被接受的代码形态。

## 曾考虑的替代方案

- **并入 AGENTS.md 正文：** AGENTS.md 是结构协作宪法，塞满代码风格条目会稀释其修订指向性；判断性内容放 skill、结构事实留 AGENTS.md。取 skill + 一行指针。
- **并入 `answra-submit`：** 提交自检是末端检查点，覆盖不了"边写边正确"；两份 skill 职责不同、互相衔接。
- **引入 ESLint 自定义规则或 golangci 类工具强制：** 类型收窄、括 catch-all、命名可由 biome 部分覆盖，但"防御预算""co-location""抽象时机"是设计判断，工具拦不住；仍以人工/AI 自查为主，工具兜机械底线（biome + typecheck + architecture:check 已存在）。

## 后果与防回退

- skill 条目与 AGENTS.md、architecture guard 冲突时，以门禁/architecture guard 结论为准并更新 skill。
- 规范演化走 Note；榜例代码被重构移位时同步更新引用路径。
- 防 AI 病灶回退：`unknown` 逃逸、catch-all、魔法值、跨包深导入是高频复发项，评审与自查必须每轮点名。

## 验证

- `pnpm notes:hint` 对本变更的配对提示消除。
- skill 中所有榜例（contracts.ts、protocol.ts、store.ts、ime:prepare、INTERVIEW_AUDIO_CREDIT_BATCH）在当前代码中真实存在。
