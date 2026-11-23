# Note：会话架构文档迁入 skill 分层目录

状态：已实施

## 问题

会话架构知识（进程拓扑、事件、状态、Bot、工具、持久化、投影）此前散落在 100 多份 Note 与 `AGENTS.md` 里。放进 `docs/notes/` 的完整版需要逐层翻目录才能找到，AI 助手也不会主动遍历 Note 树；结果是最该被随时查阅的架构图反而最难查，迁移后新旧词汇混用也更难定位。

## 涉及范围

- 文档/流程：`.agents/skills/answra-arch/`（新增）、`AGENTS.md`「文档」节指针、`docs/notes/implemented/architecture/2026-11-23-session-architecture-overview.md`（删除，内容迁入 skill）
- 相关 Note：[会话帧契约与命名迁移](../../proposed/architecture/2026-11-22-session-frame-contract-and-naming.md)

## 决定

- 会话架构的速查与决策记录全部放在 `.agents/skills/answra-arch/`，按主题分层：`SKILL.md` 只做索引与红线摘要，主题文件各自回答一个问题。
- 文件划分：`topology.md`（进程/包/消息旅程）、`events.md`（双通道与写入顺序）、`state.md`（四层所有权）、`bots.md`（目录与交接）、`tools.md`（执行与授权）、`persistence.md`（存储与恢复）、`projection.md`（UI 折叠）、`navigation.md`（落层判断与红线）、`decisions.md`（取舍、已知偏差、验证锚点）。
- `docs/notes/` 只保留本落点决定，不再承载架构正文；`AGENTS.md` 只保留一句指针。
- 明确不做：不在两处维护同一份正文；不把 skill 当成决策 Note 的替代品（单点取舍仍写 Note）。

## 流程变化

- 查阅路径：`AGENTS.md` → `.agents/skills/answra-arch/SKILL.md` → 按索引打开单个主题文件，不再遍历 `docs/notes` 目录树。
- 更新责任：改事件、写入顺序、存储或投影时，同笔更新对应主题文件；新增领域/通道/宿主时同步 `events.md`、`state.md`、`projection.md`、`navigation.md`。
- 生命周期：`decisions.md` 里的「已知偏差」是带日期的快照，迁移收尾后必须删除或改写对应行。

## 曾考虑的替代方案

- **保留 `implemented/architecture/` 完整版，skill 只放摘要：** 两处正文会漂移，且用户明确要求只保留一份、全部放 skill；摘要版又会在改动时先过期。故删除完整版，内容整体迁入 skill。
- **单文件 `SKILL.md` 塞下全部内容：** 一次加载把拓扑、事件、状态、工具、存储、投影全灌进上下文，既浪费 token 又难定位；分层后按问题只读一个文件。故拆为索引 + 主题文件。
- **放在 `docs/notes/` 并用 README 建索引：** 仍然要人主动打开文档站；AI 助手不会在写代码前先读 README 索引。skill 会按 description 自动进入可用列表，是唯一能"随时可查"的载体。
- **改 `check-notes.mjs` 让 `.agents/skills/` 变更豁免 Note 要求：** 门禁是仓库级约束，为一次文档搬迁放宽规则会削弱后续变更的留痕要求。故保留一条最小落点 Note，而不是改门禁。

## 后果与防回退

- 速查成为单一入口：`AGENTS.md` 只指向 `SKILL.md`，正文只在 skill 内，避免双份维护。
- 风险是 skill 与代码漂移。约束：`SKILL.md` 只放索引与三条红线，不复制 zod 字段；主题文件里的符号与路径改动必须同笔更新。
- 删除的完整版 Note 曾包含「问题/替代方案/验证」，已完整迁入 `decisions.md`，不再保留第二份。
- 若未来 skill 机制不可用（例如换宿主），需要把 `SKILL.md` 与主题文件合并回 `docs/notes/`；迁移成本低，因为内容按主题已分好。

## 验证

- `pnpm notes:check` 通过（本 Note 为本次变更的配套留痕）。
- `.agents/skills/answra-arch/SKILL.md` 的 frontmatter 被识别，skill 已注册为 `answra-arch`。
- 内容锚点在 `decisions.md`「验证锚点」中逐条列出，2026-11-23 已核对。
- 反向检查：全仓只有 `sessionRuntimeJournal.ts:60` 一处 `frames.publish(toSessionFrame(...))`。
