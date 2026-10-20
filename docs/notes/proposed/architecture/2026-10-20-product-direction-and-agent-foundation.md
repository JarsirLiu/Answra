# Note：产品方向与 Agent 底座（多能力域）架构组织

状态：提案

## 问题

产品需求正从单点截图答题扩展为多条能力线：实时语音面试辅助（在途）、会议助理、文档共创（Word 简历改写）、跨应用快捷键补全等微型功能。这些场景共享同一批底层机制——模型流式调用、取消与打断、工具循环、会话存储、媒体吞吐——但当前只有 `conversation` 一个完整领域：

- `apps/agent/src/conversation/runtime.ts` 同时承担模型执行器和对话领域逻辑，第二、第三个领域接入时只能复制或继续往里加分支；
- 平台能力跨进程通道目前只有 `token-request` 一种反向请求帧，工具执行（读文件、查窗口、操作文档）没有通用通道；
- agent loop 与工具调用完全不存在，"AI 执行工具查看文件或直接回答"无法落地；
- 没有一份记录产品总方向的文档，后续团队按各自理解接需求，容易在错误层面（renderer 注入 prompt、把算法塞进 worker 投影、恢复会话 ID 推断）走回头路。

先冻结"产品支柱 → 架构组织"的对应关系，才能支撑多能力并行开发而不互相踩踏。

## 涉及范围

- 代码/模块：`apps/agent/src/` 新增平级 `core/` 与未来 `voice/`、`meeting/`、`inline/`、`document/` 领域目录；`apps/agent/src/worker/protocol.ts` 反向请求帧扩展；`apps/desktop/src/main/` 平台工具实现落点。
- 进程/协议表面：`AgentCommand`/`AgentFrame` 按域分段扩展；`token-request` 泛化为通用 `host-request`/`host-response`；单 Electron utility process 起步。
- 相关 Note：[对话与答题 AI 领域拆分及对话能力复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)、[面试语音运行时模块边界与并行开发契约](2026-10-19-interview-runtime-module-boundaries.md)、[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[Agent 模块组装点与宿主传输抽象](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)、[对话会话与内存仓储端口](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)、[答题运行认领竞态修复](../../implemented/bug-fix/2026-10-20-answer-run-claim-race.md)、[拒绝将 Pi 作为桌面 Agent Runtime](../../rejected/architecture/2026-10-11-pi-agent-runtime-for-conversation.md)。

## 提案

### 产品支柱

产品定位：Windows 桌面屏幕 AI 助手——围绕"你在屏幕上看到的、正在听的、正在写的"提供实时辅助。能力线分为五类，全部以悬浮导航的统一交互表面呈现：

| 支柱 | 状态 | 核心机制 |
| --- | --- | --- |
| 屏幕问答（截图答题、读文件问答） | 已上线 | 通用对话 + 一次性答题、图片输入 |
| 实时语音辅助（面试） | 在途 | 采集→VAD→ASR→面试官轮次→可打断回答（见 10-19 Note） |
| 会议助理 | 未来 | 复用语音管线，下游换成实时纪要、材料整理、辅助回复 |
| 文档共创（简历/报告改写） | 未来 | 多轮对话 + 文档领域工具 |
| 跨应用微功能（快捷键补全等） | 未来 | 低延迟单发 run、独立触发器，不进历史存储 |

这些支柱不共享业务上下文和 profile，只共享底座机制——与 10-18 Note 的"共享执行、不共享行为配置"决策一致，且该原则从两能力扩展到任意能力。

### 架构组织（apps/agent 内部）

```text
src/
  worker/        线协议 + 命令分发 + 各域投影（唯一跨进程边界）
  core/          跨领域共享底座（见五件套）
  conversation/  已有：多轮对话、一次性答题
  interview/     在途：音频→turn→回答
  voice/         未来：vad/transcription/turns 从 interview 机械提升，面试/会议共用
  meeting/ inline/ document/   未来能力域，平级加入
```

依赖方向：`domains → core`，`core` 不得反向导入任何领域，领域之间禁止互导（`voice` 作为被多领域消费的音视频管网例外，但只暴露端口）。`worker` 调用领域方法并投影帧，领域不知道线协议。桌面平台能力（采集、键鼠、窗口、密钥、文档编辑执行）留在 desktop，运行时只持有端口——维持 AGENTS.md 既有约束。

### 底座五件套（core/）

1. **模型执行器**：provider 访问、流式 chunk、取消、错误归一化、模型配置快照。从 `conversation/runtime.ts` 抽取；interview 回答工作流是第二个消费者。
2. **Run 生命周期**：`runId` + AbortController + generation 过期丢弃 + 每域并发上限。interview reply 的"新 turn 立即 abort 旧 generation、迟到结果丢弃"模式即打断对话的标准语义，泛化为全体领域的取消/过期原语。
3. **反向能力通道（host bridge）**：把 `token-request` 泛化为 `host-request`/`host-response`（capability + payload，来源白名单）。这是工具跨进程的唯一通道：读文件、查窗口、剪贴板、文档读写全部走它；延续反向请求等待表 + 超时上限的现有模式。
4. **工具注册表**：Agent 静态注册，按 profile 授权；两类实现——worker 内纯工具、host bridge 平台工具。renderer 永远不能注入 prompt 或工具（10-18 红线）。
5. **Agent loop**：先用 AI SDK 自带多步工具循环（`stopWhen`/maxSteps）+ AbortSignal，不自研；打断裂度或顺序控制实测不足再自研，期间以 (2) 兜底。

### 触发纪律（2026-10-20 修订，依 answra-code"抽象等第二消费者"）

五件套不是一步建齐的清单，而是逐件由真实第二消费者触发的抽取动作；第一个领域内不预留任何 core 能力：

1. **模型执行器 + Run 生命周期**：触发器为 interview 阶段 6（reply workflow）实际到场。到场前唯一允许的动作是把 `conversation/runtime.ts`（已约 400 行、顶到规模预算）做域内垂直拆分：请求校验与图片解析、时间注入、错误摘要等纯函数分文件——类型不变、行为不变、测试不变，使后续抽取成为机械移动。
2. **host bridge（`token-request` → `host-request`/`host-response`）**：触发器为第一个真实工具需求。只有 token 一个能力时不提前泛化；工具需求到来时以 token 与新工具为两个真实 capability 一次落地（白名单枚举、payload 类型化）。
3. **工具注册表**：随第一个工具需求引入，静态注册 + profile 授权，不为"将来可能有"的工具预留。
4. **agent loop**：随第一个工具需求引入，直接用 AI SDK `stopWhen`/maxSteps + AbortSignal；不自研 loop，打断裂度实测不足再重新提案。
5. 抽取/泛化的共同形态：先在 `core/contracts.ts` 落端口类型（执行器、Run 凭据 runId/generation、过期丢弃），再机械上移实现；conversation 与新消费者双消费验证；`pnpm verify` 全绿 + 既有测试不改行为是唯一证据；`worker/` 协议零变化。
6. core 只放机制、不放策略：每域并发上限、ephemeral 单活不变量、profile 配置留各自领域组合根；core 只提供 registry、abort、过期丢弃与流式执行原语。

### 各支柱落法

- **面试**：继续按 10-19 Note 八阶段推进；`source` 维度天然支持 interviewer/candidate 双路，候选人麦克风是新增 source，不改产品决策层。
- **会议**：语音管线（PcmFrame 格式、credit 窗口、turn assembler）是面试管线的第二个消费者；启动时把 `vad/transcription/turns` 从 `interview/` 机械提升为平级 `voice/`（10-19 Note 的边界本就只把 reply 留在 interview 专属），下游新增纪要与材料整理 workflow。
- **文档共创**：`conversation` + 文档工具。Agent 产结构化编辑计划，desktop 执行 docx/PDF 操作（重 IO、权限、Office 交互全留平台侧）；交互形态为对话内"读→建议→应用"三步提高可审性，不做自由 IO 型 agent。
- **快捷键补全**：最薄的新域——独立 profile + 短超时 + 单发可抢占 run，不进历史存储；新增的主要是触发器（快捷键、目标应用光标位置）与最小 UI 表面，不是新底座。
- **工具答问**：现有答题/通用对话 profile 增配授权工具清单（如当前窗口或文件上下文），走 (3)(4)(5) 即可，无需新领域。

### 实施顺序（2026-10-20 按触发纪律修订）

1. **现在到 interview 阶段 6 之前：** 不建 `core/`。仅对 `conversation/runtime.ts` 做域内纯函数拆分（规模预算内职责切分，非架构抽取）；各阶段推进照原 10-19 Note。
2. **interview 阶段 6 到场：** 先冻结 `core/contracts.ts` 端口（模型执行器、Run 凭据与取消语义，reply 的 `AnswerGenerator` 端口以 core 实现为后备），再机械上移实现；conversation 与 reply 双消费定型。
3. **第一个真实工具需求到场：** `token-request` 泛化为通用 capability 帧 + 工具注册表 + AI SDK loop，一并最小落地；接的第一个工具优先选有明确产品价值的（答题或面试的上下文文件工具）。
4. **meeting 启动时：** 执行 `voice/` 提升（纯移动 + Note）。
5. **inline 作为最薄新域最后接入。**

原顺序（先抽 core → 泛化 bridge → 接工具）在"第一消费者不预留"纪律下修正为以上事件驱动顺序；原条目保存在本节历史里以便对照。每步单独立 Note；已实施后本提案迁入 `implemented/` 并改写为决定。

## 模块边界

- `apps/agent/src/core/`：模型执行、Run 生命周期、host bridge、工具注册、loop。不得包含任何产品策略（提示词、领域分支、会话规则）；被多领域复用是其唯一存在理由。
- 领域目录（conversation/interview/…）：领域状态机、策略与组合根；`<domain>/runtime.ts` 只装配端口，不发展成多领域万能 service（沿用 10-19 约束）。领域间靠事件端口消费，不互导实现。
- `apps/agent/src/worker/`：命令分发与帧投影；`AgentCommand` 按域拆子 union 合并，host 分发保持薄 switch；每个域的投影文件独立演进。
- `apps/desktop`：平台能力实现（采集、注入、窗口、密钥、文档执行、host bridge 的宿主侧应答）；只校验和转发类型化命令。
- `packages/shared`：跨进程稳定请求/响应与展示 DTO；不出现 provider wire 类型、VAD 参数或工具实现。
- `packages/ui`：按域独立 hook 与面板；低层流/取消 adapter 可复用，业务 hook 不按模式 ID 切换行为。

## 曾考虑的替代方案

- **自研完整 agent loop（含工具调度与记忆压缩）再接入：** 控制力最强，但当前工具场景尚未出现自研循环才可满足的需求；先用 AI SDK steps 快速起步，实测打断裂度不足再自研，避免在工具生态成形前预支复杂度。
- **每个能力域独立 sidecar 进程：** 故障隔离与资源上限更强，但跨进程命令/帧、生命周期与打包成本翻倍；当前各能力负载（文本流 + 音频）单 utility process 可承受。保留 `apps/agent` 包结构与传输抽象（host composition Note 已预留），未来拆分是部署决策而非代码重写。
- **引入通用插件框架或 DI 容器：** 违反 10-19 风险条目（超出当前多 provider 需要的通用机制不引入）；静态注册 + 类型端口已满足并行开发。
- **会议并入 interview 领域：** 短期少一个目录，但回复策略（面试建议）与纪要策略（材料整理）很快会互拖；语音管网属共享资产，提升为平级 `voice/` 后两个领域是平级消费者。
- **文档编辑让 agent 直接操作文件系统：** 违反进程边界与安全模型（平台能力留 desktop、工具白名单）；由 host bridge 过闸。

## 验收标准

- 可观察结果：新能力域以"注册 profile + 新增命令子 union + 新增投影"接入，无需修改 `core/` 或其他领域；打断/取消在所有领域语义一致（同 runId 语义、同过期丢弃规则）；任何新工具先过白名单注册。
- 自动化验证：架构测试断言 `core` 不导入领域、领域不互导、领域不导入 worker；core 五件套各有独立契约测试且被至少两个领域消费后才算定型。
- 需要的实机验证：每个能力域按自身 Note 验证；本提案的实施各步在合并时提供对应 agent/desktop 的 typecheck 与测试证据。

## 风险

- **core 抽取时机：** 过早抽取是为假想使用者抽象；以 interview 阶段 6 作为触发器（第二消费者到场才抽取），否则核心可能照着对话领域的形状抽歪。触发纪律修订后，host bridge、工具注册表与 loop 同样挂在真实事件上，禁止按清单预建。
- **host bridge 泛化成万能 RPC 隧道：** capability 必须白名单枚举并进协议类型；不允许 payload 里塞任意脚本或路径表达式。
- **`voice/` 提升带来中断性迁移：** 纯机械移动 + 全量改名测试；错过时机（meeting 实现引用了 interview 内部符号）会造成真正跨域依赖，需在提升前守住。
- **工具权限面扩大：** 静态白名单 + 每域授权清单 + 审计日志缺一不可；文档类工具尤其要求 desktop 侧执行与用户可见确认。
- **协议膨胀：** 按域拆子 union 只减缓不消除；协议演进必须保持帧版本化与向后兼容（现 `version: 1` 约定）。
