# Note：answra-code 定稿（四篇结构、最高纪律、提交自检收编）

状态：已实施

## 问题

第一版 `answra-code` 写得仓促：条款是散点堆叠，没有结构脉络，AI/新协作者接管时不知道先查哪条、后依哪条；提交自检（`answra-submit`）与代码规范分处两个 skill，路径重复。同时维护者进一步明确**最大的纪律**：不得为完成用户需求而牺牲代码规范与质量——"看起来功能正常、内部大量不合理"的代码不合规、不求交付，绝不产出；宁可停下客观报告缺口。

## 涉及范围

- 代码/模块：
  - `.agents/skills/answra-code/SKILL.md` 全文重写为四篇结构：上篇·能不能动笔（§1 前置条件闸门、§2 代码归属表）；中篇·怎么写才合规（§3 契约、§4 状态显式来源、§5 防御预算、§6 模块与抽象、§7 魔法值）；下篇·写到什么程度（§8 规模预算、§9 可读性、§10 测试证明）；终篇·落笔到提交（§11 门禁与提交纪律、§12 自查十四问）。
  - 删除 `.agents/skills/answra-submit/`；提交前检查（范围意图、Note 配对、全量门禁、diff 自审、秘密与工件、Conventional Commits）收编于 §11，不再单设 skill。
  - `AGENTS.md` 指针更新：提交自检指向 answra-code 终篇。
- 流程表面：不改变任何门禁命令或 CI 行为；skill 变为单一入口体系。
  - 相关 Note：[提交前 AI 自检 skill](../../archived/process/2026-10-20-ai-submit-self-check-skill.md)（归档）、[代码工程规范 skill](2026-10-20-code-standards-skill.md)（首版）、[前置条件闸门](2026-10-20-precondition-gate.md)、[状态显式来源与规模预算](2026-10-20-state-explicitness-and-size-budget.md)、[产品方向与 Agent 底座提案](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)。

## 流程变化

- skill 使用路径简化：写前读上篇 → 写中对中篇负责 → 写完按下篇与终篇自查；评审四篇逐条核对，缺一即驳。
- 新增"最高纪律"条款（总纲内）：任何情况下不得为完成用户需求而违反本规范；"用户在催""既有代码也这么写""这样最快"均不构成降级理由；停下报告是合格产出，"看起来正常"的不合理代码是负资产，不是完成。
- 榜例校订：全部改为当前仓库真实文件与机制（`contracts.ts`、`protocol.ts`、`beginEphemeralRun`、`pcmFrameValidator.ts`、`interviewProjection.ts`、`ime:prepare`、`INTERVIEW_AUDIO_CREDIT_BATCH`、竞态修复不变量测试、deferred 计时测试）。
- `pnpm notes:hint` 对行为/流程变更的提示仍由本 Note 消除；严格校验仍走 `pnpm notes:check`（CI/发布）。

## 决定

- `answra-code` 作为代码质量唯一入口，四篇覆盖"能不能动笔→怎么写→写多好→怎么提交"，删除 `answra-submit` 作为独立 skill（收编而不复用）。
- 最高纪律置于总纲：需求紧迫度与规范发生冲突时规范优先；对 AI 的执行口径是"停下报告也算完成，强行完成永不合格"。
- 评审驳回标准四篇化：任何一篇的硬禁令（杜撰接口、推演状态、catch-all 裸吞、顺手重造、`utils/` 大杂烩）命中即驳，无需面面俱到。

## 曾考虑的替代方案

- **保留两个 skill，分工不变：** 提交自检只有七条且单独成 skill 价值有限，跳表找规则反而增加错漏；收编后单一事实源。
- **在 AGENTS.md 维持旧指针链：** 三/四条指针并存，AI 每次要核对多个文件；统一到 answra-code 一个入口，AGENTS.md 只留一行。
- **把最高纪律只写进 AGENTS.md：** AGENTS.md 是结构宪法，纪律属于写码规范执行体，放总纲处恰逢 AI 每次触发的位置。

## 后果与防回退

- skill 权威即"写代码必读"：触发条件（description）已声明写、改、评审 TS/TSX 均适用；后续行为变化不一定再走本 Note 条目——规范评审中发现的分支会持续小步修订。
- 防回退点：一旦出现"为了完成任务而不合规范"的案例，审查时把违规 skepticism 对准"最高纪律"逐条核对，而非仅扣某个条款细节；评审有责任决定将其归档或记入退化案例。
- 收编后 skill 数量收敛为 3（answra-change / answra-code / answra-vision），职责不再重叠。

## 验证

- `pnpm notes:hint` 无未配对提示；归档的 `answra-submit` Note 仍可从其它 Note 链到（链接不断）。
- skill 四篇小节编号连续、榜例文件真实存在（contracts.ts、protocol.ts、pcmFrameValidator.ts、interviewProjection.ts、runtime.ts 等均为现役代码）。
