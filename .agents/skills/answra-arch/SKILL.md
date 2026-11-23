---
name: answra-arch
description: Answra 会话架构速查：进程拓扑、一条消息的旅程、durable/live 事件双通道、Turn/Step 状态所有权、多 Bot 与交接、工具执行、SQLite 持久化与恢复、UI 投影。写或改 agent runtime、desktop main、CLI TUI、remote 或 UI 投影代码前先读；判断某个改动该落在哪一层、事件该走哪条通道、状态该由谁写时使用。
---

# Answra 会话架构速查

本 skill 是会话架构的唯一速查入口，按主题分层存放；一切以代码符号为准。
先读本页的索引与红线，再按需要打开对应文件，不要一次性全读。

## 按依赖方向阅读

1. `topology.md` —— 谁在哪个进程、一条消息怎么走
2. `events.md` —— 事实怎么产生、走哪条通道、按什么顺序落
3. `state.md` —— 谁拥有状态、谁写游标、取消怎么收敛
4. `bots.md` —— Bot 是什么、怎么注册、怎么切换
5. `tools.md` —— 工具在哪执行、谁授权、边界在哪
6. `persistence.md` —— 存哪、两张表、怎么恢复
7. `projection.md` —— UI 怎么折叠、游标规则、各宿主现状
8. `navigation.md` —— 改代码前的落层判断与防回退红线
9. `decisions.md` —— 为什么这么定、已知偏差、验证锚点

## 索引

| 文件 | 回答的问题 | 什么时候读 |
| --- | --- | --- |
| `topology.md` | 进程/包怎么分、消息从哪进、写到哪 | 不确定改动该落 desktop / agent / CLI / ui |
| `events.md` | 事件 → 条目、durable/live 双通道、唯一写入顺序 | 加条目、改帧字段、排查丢帧/乱序 |
| `state.md` | 条目 / Turn 投影 / snapshot / view 四层所有权 | 改活动槽位、`lastSeq`、取消、恢复 |
| `bots.md` | Bot 四件套、不可变 catalog、handoff 与选择 | 加 Bot、改授权、排查切 Bot 失败 |
| `tools.md` | 执行位置、声明式授权、步数上限、输出中继 | 加工具、改工具授权、排查工具超时 |
| `persistence.md` | 域 × 存储、SQLite 两表、恢复三步、凭据边界 | 改存储、写迁移、排查启动丢消息 |
| `projection.md` | 共享 fold、两处游标机、工具展示 | 改 UI 折叠、排查重复/缺失消息 |
| `navigation.md` | 「改 X 先看 Y」+ 红线清单 | 动笔前最后过一遍 |
| `decisions.md` | 落点取舍、已知偏差、验证锚点 | 质疑设计、迁移收尾、需要证据 |

## 三条最常踩的红线

1. 每条 durable 条目只有一个写入顺序（`SessionItemRecorder.append`）：内存视图 → 条目 → 帧广播。全仓只允许一处 `frames.publish(toSessionItemFrame(...))`。
2. `seq` 只由 `SessionItemStore.appendItems` 分配；宿主折叠必须 `seq === lastSeq + 1`，缺口整段重读，不得补号或跳号。
3. 恢复必须先补收口条目、再重建 transcript，最后才消费 queued Turn；顺序颠倒会丢用户消息。

完整红线与落层判断见 `navigation.md`。
