# 工程 Note 索引

仓库的功能决策、方案、缺陷复盘、架构约束和流程经验统一记录在 `docs/notes/`。文档使用中文；代码符号、路径和 API 名称保留原文。

## 开始工作

1. 阅读根目录 `AGENTS.md` 和 `.agents/skills/answra-change/SKILL.md`。
2. 在 `docs/notes/` 查找对应功能、模块或历史问题的 Note，先确认已有决定和明确禁止的回退。
3. 功能新增、删除、用户行为变化、有复盘价值的缺陷、跨模块契约、架构、依赖、持久化、测试策略和工具流程，都必须在同一变更中新增或更新 Note。
4. 一项变更含有多个独立功能或决策时分别记录；不能用一条泛化 Note 遮盖彼此无关的取舍。
5. 运行 `pnpm notes:check`；完整提交前运行 `pnpm verify`。

## 生命周期和路径

Note 路径为 `docs/notes/<生命周期>/<类别>/YYYY-MM-DD-主题.md`。

- `proposed/`：待评审的方案；实施后迁入 `implemented/`，否决后迁入 `rejected/`。
- `implemented/`：已经交付的决定，内容必须对应当前代码和实际验证。
- `rejected/`：明确否决、但未来可能再次诱发错误的方案；保留否决理由和错误假设。
- `archived/`：仅存放已经失去未来指导价值的已实施 Note；安全边界、防回退依据和重要替代方案不得归档。

类别使用 `feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。模板在 `docs/notes/templates/NOTE-TEMPLATE.md`。

每份 Note 必须写明问题、影响范围、决定、考虑过的真实替代方案及舍弃原因、后果，以及测试证据或未来防回退条件。删除或收缩能力还必须写明移除内容和重新引入条件；缺陷修复必须写根因、修复和回归保护。

## 门禁

`pnpm notes:check` 检查 Note 目录、文件名、状态、必需章节、替代方案内容、本地 Markdown 链接，并检查代码或工程流程变更是否配套 Note。门禁不能替代作者和评审者判断：每项独立决策仍需单独留痕。

`docs/` 根目录只保留本入口文件；新的功能、交互、架构或流程文档必须进入 `docs/notes/`。
