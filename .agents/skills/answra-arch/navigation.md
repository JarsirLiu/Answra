# 落层判断与防回退红线

本文件回答：这个改动该放哪、哪些做法一碰就错。

## 改 X 先看 Y

| 你要改的 | 先看 | 别做 |
| --- | --- | --- |
| 新事件 / 新帧字段 | `shared/src/schema/events.ts`、`session/frame.ts` | 别在 agent 里私自定义 payload 类型 |
| 事实写入时机 | `sessionRuntimeJournal.ts` | 别绕过 `append` 直接写 journal + 广播 |
| transcript 投影 | `transcriptBridge.ts` | 别在 bridge 里改 Turn 状态或补 seq |
| 调度 / 排队 / 取消 | `core/session/scheduler.ts` | 别在领域里复制 busy 判断 |
| 新 Bot | `bots/<域>/` + `core/bot/catalog.ts` | 别往 catalog 塞运行期对象；别用 renderer 注入 prompt/工具 |
| 新工具 | `core/tool/builtin/` + `ToolId` | 别让 desktop 代执行或反向 RPC |
| 存储 / 迁移 | `persistence/sqlite/`（baseline + `_migrations`） | 别删库、别用全局 SCHEMA_VERSION |
| UI 折叠 | `conversationView.ts` + 两处宿主 | 别在组件里解析工具输出，走 `tool-presentation` |
| 远程 / 移动 | `packages/remote`（协议）、`remote-node`（Node 适配） | 别在 controller 侧依赖 `remote-node` |
| 桌面平台能力 | `apps/desktop/src/main/*` | 别让 agent import Electron；别把平台能力做成工具 |

## 落层判断（改代码前按顺序问）

1. 是协议/词汇问题？→ `packages/shared/src/schema/`，同步帧与事件两处。
2. 是 Turn/Step/调度/恢复问题？→ `apps/agent/src/core/session/`，不在领域里补。
3. 是某个域的行为？→ `apps/agent/src/<域>/`，先看该域 profile/policy。
4. 是宿主接线？→ desktop main / CLI 组合根，只接线不复制语义。
5. 是渲染？→ `packages/ui`，复用 fold 与 tool-presentation。

## 防回退红线

- 每条 durable 事实只有一个写入顺序；全仓只允许 `sessionRuntimeJournal.ts` 调用 `frames.publish(toSessionFrame(...))`。
- `seq` 只由 journal 分配；宿主不得补号、不得跳号折叠。
- transcript 写失败不回滚已追加事实；`lastSeq` 不因投影失败而前进。
- 恢复必须先写回 transcript 再消费 queued Turn。
- 授权缺省即无：未注册工具 ID 直接 throw；renderer 永不注入 prompt/工具。
- 旧 envelope（含 `run-state-changed`）不是事实目录，不进 journal、不进帧。
- 不在 desktop 复制连接/重试/信令语义；不在 controller 侧依赖 `remote-node`。

相关：`decisions.md`（这些红线的由来与验证）。
