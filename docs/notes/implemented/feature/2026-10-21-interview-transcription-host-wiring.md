# Note：面试 VAD 分段接本地转录引擎的宿主接线（阶段 4 消费者）

状态：已实施

## 问题

[本地内置 ASR 路线](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md) 的链路缺口（第 2 项）一直未补：

1. VAD 切出的分段只入内存暂存（`vad/pipeline.ts` 的阶段 3 形态），除评测直接读暂存外无任何消费者；
2. `LocalParaformerAdapter`（阶段 2）只有评测 harness 调用，产品里没有 `transcript-event` 的生产者；
3. 线协议 `InterviewWorkerEvent.transcript-event` DTO 与投影早已冻结，但 worker 从不发该事件——desktop main 订阅了也收不到东西。

桌面侧引擎装配（[上一批](2026-10-21-asr-paraformer-engine-assembly.md)）已把 addon 与组合根胶水立起来，宿主接线批（用户裁定随后单批推进）把以上三处闭合，使一次 `interview-start` 会话能完成"采集 → VAD 切段 → 本地解码 → transcript-event 上帧"。

## 涉及范围

- `apps/agent/src/interview/transcription/local/recognizerPort.ts`：新增 `RecognizerSource` / `RecognizerAssembly` 组合根端口（与 `TenVadSource` 同形态）。
- `apps/agent/src/interview/transcription/pump.ts`（新增）：转录泵——串行解码链、会话生命周期与迟到丢弃。
- `apps/agent/src/interview/vad/pipeline.ts`：`InterviewVadPipelineOptions` 新增 `onSegment` 分段回调（暂存保留为观察点）。
- `apps/agent/src/worker/host.ts`：`AgentHostOptions.recognizer` 必填；engine 装配共享、interview-stop/fail 泵生命周期、`stagedInterviewVadSegments` 删除（阶段 4 已接管）。
- `apps/desktop/src/main/conversation/workerTransport.ts` / `agentService.ts` / `worker.ts`：desktop 把 `createParaformerRecognizerModule` 注入 host；utility process fork 参数新增 ASR 资源目录（argv[3]）。
- 测试：`apps/agent/test/worker/host.test.ts`（+2：转配失败、端到端分段→事件）、`apps/agent/test/interview/transcription/pump.test.ts`（新增 4 条）、`apps/desktop/test/interviewWorkerTransport.test.ts`（注入假装配）。

相关 Note：[桌面侧引擎装配](2026-10-21-asr-paraformer-engine-assembly.md)、[LocalParaformerAdapter](2026-10-21-local-paraformer-adapter.md)、[面试运行时模块边界](../../proposed/architecture/2026-10-19-interview-runtime-module-boundaries.md)。renderer 上屏与候选人麦克风采集属后续批次，届时另行记档。

## 决定

### 组合根端口与注入方向

- `RecognizerSource.load(): Promise<{ module, recipe }>`——desktop 读盘校验（[上一批](2026-10-21-asr-paraformer-engine-assembly.md) 的胶水），agent 只持端口；host 以 `recognizer` **必填**选项组合（与 `vad` 同级），缺省由 desktop transport 注入 `createParaformerRecognizerModule(asrResourceRoot)`，测试注入假装配。
- engine promise 共享、失败共享：首次 `load()` 失败的 rejection 会贯穿 worker 生命周期（同 VAD 引擎加载语义），修复资源后须重启 worker。

### 转录泵（pump）语义

- **串行链**：一次会话一个 `chain: Promise<void>`，分段按到达顺序解码。本地离线解码是同步 native 调用，串行防止长段解码饿死后续小段，也让锁在事件顺序上可预期；不引入并发池。
- **生命周期**：`stop/fail` 从 sessions map 删除并 `abort()`；已排队但未开始的分段直接丢弃（不解码）；在途解码完成时结果事件若其会话已被删则全部丢弃（pump 内 guard）。取消的解码在 adapter 层归一化为 `cancelled` 事件——同样被丢弃，失效会话不投递任何事件。
- **adapter 抛错**不炸链（console.warn 守卫）；provider 的可重试错误仍以 error 事件投出，重试决策留给将来 turn assembler。
- **暂存不被替换**：`pipeline.stagedSegments` 与 `onSegment` 并存——暂存是测试/评测观察点（`VAD_STAGING_SEGMENT_LIMIT` 语义不变），消费者不依赖暂存。评测 harness 的 `pipeline.stagedSegments` 用法不受影响。

### host 组装

- `interview-start`：VAD 引擎装载成功后才装配 transcript provider；两者任一失败都会把会话打成 `runtime-failed` 并回错误响应（fail-closed，不静默降级为无转录会话）。
- `interview-capture-failed` / `interview-stop` / runtime `failSession`（VAD 段错误）均同步通知泵 stop；`dispose` 泵全停。
- `AgentHost.stagedInterviewVadSegments` 删除：阶段 3 的观察通道在阶段 4 接管后没有剩余消费者（grep 全仓无引用）。

## 曾考虑的替代方案

- **`recognizer` 设为可选（未注入则只采集不转录）**：把"没有引擎"藏进运行时静默状态，违反显式失败纪律；必填让 desktop transport 显式给出装配源。
- **泵消费 `TranscriptionProvider`（contracts 的 union）**：union 的 streaming 形态当前没有实现与消费者，接 union 反而让泵承担两者分支；直用 `LocalParaformerAdapter` 具体类型，流式 provider 出现时再演进泵。
- **provider 装配放进 pump**：pump 只做"消费分段→投事件"，装配是组合层职责；分开保住模块可测性（pump 单测不碰磁盘/addon）。
- **VAD 与 recognizer 装载并行**（`Promise.all`）：省 1–2s 启动，但错误路径要同时处理两类失败与半程清理；首版保持顺序，两个资源装载本身不互锁，并行化留待实测需要时再做。
- **延迟批（pump→turn assembler 直接连）**：turn assembler 是下一批（批次 D 回答生成），本批只负责"分段→transcript-event"，协议边界不变更事件语义，批次拆解保持可并行。

## 后果与防回退

**后果**

- `interview-start` 冷启动成本上升：82MB SHA-256 流式校验 + addon + 模型解析（本机合计约 2–4s，一次性）。
- `transcript-event` 自本批起从 worker 真实流出，desktop main 尚无消费者（`agentService.onInterviewEvent` 仍无订阅者）——本批后 renderer 不会显示转写；上屏在下一批做。
- `host.test.ts` 全部 9 处 `startAgentHost` 调用需传假 recognizer——将来与新 host 选项同理（组合显式的测试成本）。

**防回退约束**

- `createParaformerRecognizerModule` 的入口签名（resourceRoot → Promise<{module, recipe}>）被组合回归与生产注入两条路径共用：改它必须同步改两者。
- 泵的"停止后不投递"语义由测试锁定（迟到分段、在途结果丢弃、dispose 三条）；改动生命周期须过这三条。
- `pipeline.onSegment` 与暂存的双通道不得收敛为单通道：评测直读暂存。
- utility process fork 参数顺序（argv[2]=VAD、argv[3]=ASR）不得重排：worker.ts 按位解析。

## 验证

- 2026-10-21 `apps/agent` vitest 12 文件 85 条全绿：host 11 条含装配失败（`session-failed` 事件 + 错误响应含 "ASR 资源缺失"）与端到端（scripted VAD 分段 × 假转录 → `chunk-final` transcript-event）；pump 4 条（串行、迟到分段不解码、在途结果丢弃、dispose 全取消）。
- 2026-10-21 `apps/desktop` vitest 45 文件 284 条全绿（`interviewWorkerTransport` 注入假装配走通原链路）。
- 2026-10-21 仓库 `pnpm verify`（lint/typecheck/test/architecture/notes）全绿。
