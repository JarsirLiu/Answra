# 多 Bot 与交接

本文件回答：Bot 是什么、怎么注册、怎么切换、UI 现状。

## Bot 四件套

`identity`（名称/职责/归属）、`discovery`（可见性 ACL）、`executor`（Agent 定义）、`policy`（prompt + `ToolId[]`），契约在 `core/bot/contracts.ts`。

目录在启动期构建后不可变（`createBotCatalog`：重复 ID、空身份直接 throw），运行期不增删。

## 当前 Bot 清单

| 域 | Bot | 注册方式 | 工具授权 |
| --- | --- | --- | --- |
| conversation | `conversation.general` | `createConversationBots` → `createBotCatalog` | `workspace.read/grep/edit/run-command` |
| interview 演练 | `interview.rehearsal` | `AgentRuntime.registerAgent`（不进 catalog） | `workspace.read/grep` |
| interview 资料整理 | `interview.intake` | 同上 | `workspace.read/grep/edit` |
| coding | `coding.engineer` | `startCodingHost` 单 Bot | 同 conversation + 三个 skill |
| answer | 截图答题 | 独立 host（纯内存） | 无工具 |

## 切换的两条路

1. **模型主动交接**：写 `turn-handoff` 事实；来源消息完结后为目标 Bot 占位；落库前经 `assertCanHandoff` 校验 `discovery.visibleTo`（`core/bot/directory.ts`）。交接发生在同一 Turn 内，不新建 Turn。
2. **新建会话时选择** Bot 或团队；`submitTurn` 校验 `botId === activeAgentId`，运行中不能换 Bot。

## 现状与缺口

IPC 契约（`ListBots`、会话 selection、`chat.send.botId`）已就绪；renderer 尚未提供选择入口。这不是坏了，是还没接。

## 硬约束

- 不接收 renderer 注入的 prompt、工具或发现关系。
- 新增 Bot 不改会话编排；只加目录项与 policy。
- 独立助手与团队共用同一目录；`visibleTo` 是唯一发现/交接 ACL。

相关：`tools.md`（授权怎么落到执行）、`decisions.md`（双份定义偏差）。
