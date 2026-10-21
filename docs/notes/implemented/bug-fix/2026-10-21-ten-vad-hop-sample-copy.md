# Note：TEN VAD 引擎的 hop 样本从未写入 wasm 内存

状态：已实施

## 问题

为 `apps/agent/src/interview/vad/tenVadEngine.ts` 补专属单测（阶段 3 收口遗留项[面试语音 VAD 选型](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)）时，用合成假 glue 从"原生侧视角"观察内存契约，发现 `processHop` 只把调用者样本用于长度校验，从未写入 wasm 音频缓冲就直接调用 `_ten_vad_process(handle, audioPtr, …)`。上游 TEN VAD 的 C 接口签名 `_ten_vad_process(void* handle, int16_t* audio_data, …)` 里 `audio_data` 是唯一数据输入通道；不拷贝样本，原生推理消费的就是 malloc 出来的未初始化内存。真实 WADM 资源下这意味着：**所有非静音音频都得不到正确判决**，语音事件可能完全缺失或完全错误。已提交的两个验证点（尖刀测试、桌面打包探针）都只喂过全零静音——真实的 WASM 资源下，全零样本与"未拷贝"在结果上不可区分，所以一直没暴露；`speechDetector` 的单测走 `scriptedHop` 假引擎，也覆盖不到这条路径。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/tenVadEngine.ts`（`processHop` 一处修复）、`apps/agent/test/interview/vad/tenVadEngine.test.ts`（新增，含暴露缺陷的拷贝断言）。
- UI/进程/协议/持久化表面：无接口变更；`TenVadHop.processHop` 签名不变；worker 线协议不变。
- 相关 Note：[面试语音 VAD 选型与 Agent 内适配器](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)。

## 根因

`createNativeHop` 构造 `processHop` 时，`samples` 参数进入函数体后仅参与了 `byteLength` 校验（该参数因此不会触发"未使用"告警），随后把 `_malloc` 分配的 `native.audioPtr` 原样传给 `_ten_vad_process`。emscripten 的 `_malloc` 不清理内存，`audioPtr` 窗口内容是页内残留（在本机观察常为全零）。缺失的操作与上游 `examples/test_node.js` 的用法一致：调用前 `HEAP16.set(chunk, audioPtr / 2)`。

本质：引擎包装层为每个上游函数补齐了指针读写，唯独"输入侧样本拷贝"漏掉了；没有从原生视角的观察点测试，看不出来。

## 决定

- `processHop` 在调用 `_ten_vad_process` 前加一行 `module.HEAP16.set(samples, native.audioPtr >> 1)`，把调用者的样本窗拷进 wasm 堆，再交给原生推理。契约面不变，不新增任何选项或导出。
- `tenVadEngine.test.ts` 以假绑定记录"原生侧真实读到什么"（在自己的 `_ten_vad_process` 里从 `HEAP16` 窗口取样），把"样本确实到达 wasm 内存"固化为行为断言；假分配器模拟 emscripten 约定（ptr 0 为 null、从对齐地址开始），防止测试前提失真。

## 修复

- `apps/agent/src/interview/vad/tenVadEngine.ts`：`processHop` 增加 `HEAP16.set(samples, native.audioPtr >> 1)`，附 why 注释。
- `apps/agent/test/interview/vad/tenVadEngine.test.ts`（新增）：7 条行为测试——glue 工厂注入选项契约（wasmBinary/noInitialRun/noExitRuntime/locateFile 占位路径，同时守住上一条 data: URL Note 的分支）、`_ten_vad_create` 传参（hopSize=256、threshold 透传）、创建失败 fail-closed 且四个指针全部 `_free`、**样本拷贝进 wasm 堆**（缺陷暴露点）、概率/flag 从 wasm 堆读回 Wrap 成 `HopVerdict`、检测窗长度不符抛 `TypeError` 且不触发推理、`destroyHop` 已知/未知句柄的释放与拒绝。

## 影响表面

- 修复后引擎对任何音频输入都会先完成样本拷贝；静音输入行为不变（拷零 = 零），故既有打包探针、host 测试全部保持绿。
- `HopVerdict.probability` 读自真实推理结果后，confidence 语义在非静音输入下首次真实生效；阶段 8 校准前阈值仍为占位，不改变"校准前不宣称可靠"的边界。

## 曾考虑的替代方案

- **在 `_ten_vad_process` 调用处直接传 `samples` 的拷贝并让上游指针指向它：** emscripten C 接口收的是堆内指针，不是任意 TypedArray；引入第二块缓冲等于伪造 ABI。舍弃。
- **把拷贝下沉到 detector（由调用方写内存）：** 会把 wasm 堆布局知识泄漏进检测器，`HopVad` 端口的抽象（"消费 int16 窗、同步产出判决"）即告失效。拷贝属于引擎与原生 ABI 的实现细节，留在引擎内。舍弃。
- **只用真实 WASM 写端到端测试：** 真实资源不进 Git（`vad:prepare` 才有），无法作为 agent 包内常驻回归；而且真实 wasm 里"读到全零"同样难以与"没拷"区分，观察不到根因。假 glue 的原生视角断言是唯一能在资源缺失时持续守住该契约的方式。舍弃。

## 后果与防回退

- 未来任何改动若再次把 `_ten_vad_process` 的输入与其余内存操作解耦（例如指针重排、改用指针句柄传参），`copies the caller hop window into the wasm heap before inference` 这条测试会红。
- `tenVadEngine.test.ts` 的假绑定是这份契约的单一观察点；升级 TEN VAD 时若上游 ABI 变化（参数顺序、单位），先同步假绑定与断言，再改引擎。

## 验证

- 修复前：唯一红测试 `copies the caller hop window into the wasm heap before inference`——调用者窗送入 `[-753,-502,-251,0,…]` 交替模式，假绑定从 `audioPtr` 窗口读到全零（vitest diff 证据）。
- 修复后：`pnpm --filter @answra/agent test -- tenVadEngine` 7/7 通过；`pnpm --filter @answra/desktop test` 全绿（静音探针链路行为不变）。
- 桌面打包回归（真实 WASM）与实机链路验证归 10-20 Note 阶段 7–8；本 Note 不重复宣称。
