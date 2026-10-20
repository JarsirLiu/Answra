# Note：提交前 AI 自检 skill（answra-submit）

状态：已实施
归档日期：2026-10-20

## 问题

AGENTS.md 与 Note 门禁定义了规则，但没有一份引导 AI 在提交前系统自检的可执行流程。实际协作中出现的风险模式：提交夹带他人在途文件、功能与格式化混在同一提交、门禁红了就拆测试绕过、秘密/本机产物可能入库。团队并行扩员后，这些靠口口相传的检查开始不可靠。

## 涉及范围

- 代码/模块：`.agents/skills/answra-submit/SKILL.md` 新增；`AGENTS.md` 质量门禁章节增加一行指针。
- 流程表面：不改变 `pnpm verify`、husky、CI 的任何行为；只约定 AI 在宣称"完成"、打包提交或 PR 之前执行的检查顺序（范围意图 → Note 配对 → 门禁 → diff 自审 → 秘密与工件 → 架构边界 → 提交）。
- 相关 Note：[Note 治理](../../implemented/process/2026-10-11-note-governance.md)、[产品方向与 Agent 底座提案](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)（跨域设计前的方向核对）。

## 流程变化

- 新增触发点：AI 在工作收尾、用户要求提交、或组装 PR 时必须按 `answra-submit` skill 走七步自检，而不是只跑门禁命令。
- 自检重点（此前纪律中较弱的）：一次提交一个关注点、他人 in-flight 改动不 stage、行为变化必须有测试对应、`diff` 中调试残留与 `any` 弱化显式检查。
- 提交后要求：工作区剩余条目应全部是他人在途文件；系列提交须契约先行。

## 决定

把提交前自检固化为一等 skill，与 `answra-change`（Note 流程）、`answra-vision`(方向核对) 并列成三角：写什么 Note、为什么写、怎么收尾。规则内容与既有 AGENTS/README 约定一致，不引入新工具新命令。

## 曾考虑的替代方案

- **写进 AGENTS.md 正文而不是 skill：** AGENTS.md 是全局规则，塞长清单会稀释结构约定；skill 只在提交场景注入，上下文更准。取 skill + 一行指针。
- **靠 husky/lint-staged 在钩子里强制：** 钩子能拦格式与门禁，拦不住夹带文件、范围蔓延和提交拆分判断；这些必须由 AI 自检承担。机械部分仍全交钩子。
- **扩展 `verify` 脚本增加更多静态检查：** 收益递减；本次缺口是主观判断型（范围、意图、自审），脚本化成本高于收益。

## 后果与防回退

- AI 清单中的确定性步骤应随工具演进逐步自动化（如架构边界检查已有脚本），但清单本身保持"每条可人工执行"的形态，避免只依赖单一执行者。
- 自检 skill 迭代为提名流程变更时须走 Note；skill 内容与 AGENTS.md、Note 门禁冲突时以 Note 门禁为准即更新。

## 验证

- `pnpm notes:hint` 在补本 Note 后对 AGENTS.md 与 skill 文件的变更配对提示消除。
- skill 内容与 AGENTS.md 质量门禁、CONTRIBUTING.md、`.github/pull_request_template.md` 交叉核对无冲突。

## 归档记录

2026-10-20：本 skill 按维护者决定删除，提交前检查收编进 .agents/skills/answra-code/SKILL.md 终篇（门禁与提交纪律、自查十四问），不再单设提交自检 skill。原有检查项（范围意图、Note 配对、全量门禁、diff 自审、秘密与工件、Conventional Commits）全部保留于收编位置；理由：写代码质量规范（含前置条件闸门）才是主要缺口，提交自检只是末端步骤，两处体系合并后路径更短、维护点更少。其中"架构边界"检查项由 pnpm architecture:check 机械守护，无需人工重复。
