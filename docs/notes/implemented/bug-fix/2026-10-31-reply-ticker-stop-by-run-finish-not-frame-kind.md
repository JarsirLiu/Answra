# Note：跑马灯停止判定改以运行结束信号为准——清除"最后一帧是文本"的猜测支柱

状态：已实施

## 问题

用户实测口径：答题回复完成后，跑马灯不应继续滚，必须停下并把视口定位到 AI 最终文本回复的开头。代码审计发现停止判定绑错了前提：

1. `useHorizontalTickerScroll` 的停止条件是 `phase === "text" && !pending`，而 `phase` 来自"跑马灯最后一帧活动是否为 text"（`current.kind === "text"`）。整条链路上 SDK 权威信号明明在手——协议层全程使用 AI SDK `UIMessageChunk`（`packages/shared/src/channels/conversation.ts:165`），transport 对每个 chunk 过 `uiMessageChunkSchema` 后 1:1 喂 `useChat`，`finish`/`abort` 收流，agent 还有 `run-finished` 变更对账（`useConversationChat.ts:99-111`）——但滚动钩子只消费了 pending 翻转，却又附加了一个与结束无关的巧合条件"最后一帧必须是文本"。
2. 答题收尾常见尾帧不是文本：`source-url` / `tool-output` 事件可能排在最终文本之后（带搜索、多轮工具调用的 run 尤其如此）。此时完成态 phase 停在 `"process"`，pending=false 不触发 hold，viewport 继续滑到工具/来源尾巴，永不回滚到答案开头。
3. 旧测试 `useHorizontalTickerScroll.test.tsx:113`（"keeps following the process activities after an error"）把"process 不停"钉死——本意是错误后继续跟滚，但没有区分"错误流"与"带过程尾巴的正常完成"，使缺陷有测试护栏。
4. 回填兜底也在撒谎：`ReplyActivityTicker` 在 `pending=false` 且 `replyText` 非空但活动为空时显示"等待模型输出"（LoaderCircle），完成态看起来还在等输出。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/useHorizontalTickerScroll.ts`（新增 `error` 入参、停止判定重写）、`packages/ui/src/components/panels/ReplyActivityTicker.tsx`（择帧以运行状态为准、删除 `replyText` 支柱）、`ReplyBar.tsx` / `FloatingBarApp.tsx` / `useReplyWorkflow.ts` / `ReplyBarWindowApp.tsx` / `useConversationChat.ts`（随 `replyText` 死链清理）。
- 契约/进程：shared `ReplyBarState.replyText` 字段删除（`packages/shared/src/channels/window.ts`），main 侧 `windowIpc.ts` 的状态校验同步；独立回复窗口（已废弃入口）映射更新。协变更属窗口内序列化契约，无 IPC 频道变化。
- UI 行为变化：回复完成后（无论尾帧是什么 kind）跑马灯一律停在答案开头且挂起跟滚（resize/render 都不再推进）；错误流保持"继续跟滚"以展示失败过程；完成态不再出现"等待模型输出"伪装。
- 相关 Note：无直接关联的同线 Note；与同日「原生 title 悬停提示破隐身」Note 同属展示层治理线，但互相独立。

## 决定

1. **停止＝运行结束，不猜帧**：`holdStartRef = !pending && !error`。pending 翻转（true→false）即认为运行结束（来源：AI SDK `finish`/`abort` 收流 + agent `run-finished` 对账），hold 后任何后续 render/resize 都不得推进滚动。
2. **错误是唯一例外**：`error` 在场时保持跟滚（现状行为保留），并且结束时刻不做 scrollLeft 重置，避免打断失败上下文的阅读。
3. **择帧以运行状态为准**：进行中保持现行两态（尾帧 text → 只展示尾段文本帧；否则全量最近 5 帧）；完成态一律先取"最后一个过程帧之后的文本帧"，没有文本帧才退回最近过程帧（诚实展示工具/来源尾巴，靠 hold 保证用户看到的第一屏是答案开头）。
4. **`replyText` 全链路删除**：跑马灯不再从最终答案文本反推状态（这条"以文本内容臆断运行状态"的支柱整体拆除，不留兜底）；连带清理 `ReplyBar`/`useReplyWorkflow`/`ReplyBarState` 窗口契约与 `useAiConversation` 返回值中的死字段。
5. **空活动回填修正**：完成态无活动 → "模型未返回可展示内容"；"等待模型输出"只允许在 pending 时出现。

## 曾考虑的替代方案

- **维持旧判定、要求 agent 保证"文本必须最后到达"：** 舍弃。依赖上游模型行为排序属于隐式契约，AI SDK 与供应商行为不受我方控制；协议层已经把权威结束信号送到 UI 手里，让表现层第二套猜测标准存续才是腐化源。
- **给 `finish` chunk 加投影帧接入跑马灯：** 舍弃。`finish` 是生命周期信号不是内容帧，塞进活动列表会把"停止"与内容时序重新耦合，回到同一个坑。
- **保留 `replyText` 仅作回填兜底：** 舍弃。用户明确要求错误的猜测逻辑清理干净，不留兜底——运行状态只能有一个来源。
- **完成后直接把回复条切换成静态文本组件、彻底停用跑马灯：** 舍弃。完成态还需要展示错误、无回复等诚实状态，且滚动容器是统一的无障碍 log 区域；改择帧+hold 达成同样保证且改动面小。

## 后果与防回退

- 约束一：跑马灯的任何停止/重置判定只能消费运行状态（`pending` / `error`），禁止再从投影帧的 kind 回推断"是否结束"。
- 约束二：`ReplyBarState`（窗口序列化契约）不得回加 `replyText` 这类"从最终产物反推状态"的字段。
- 约束三：错误态保持跟滚是刻意行为；若未来给错误态也加停止，必须先评估"失败过程不可回看"的损失，不得顺手删掉区分。
- 约束四：新增 chunk 类型（SDK 演进）只影响帧呈现，停止语义不受影响——这是本决定的回归保护伞。

## 验证

- `packages/ui/test/useHorizontalTickerScroll.test.tsx`：删除钉错行为的用例，改/补四条——错误态继续跟滚（pending 翻转 + error 在场）、**带 process 尾帧完成也停在开头并挂起**、完成态直挂载 hold、resize 不再推进（既有）。
- `packages/ui/test/ReplyActivityTicker.test.tsx`：完成态带工具尾帧时答案与工具帧诚实呈现且无"等待模型输出"伪装；完成态无活动 → "模型未返回可展示内容"；错误态保持可见。
- `pnpm verify`（biome + 全包 typecheck + vitest + 架构守护）全绿；`replyText` 在 src 全域清零（`rg` 复核）。
