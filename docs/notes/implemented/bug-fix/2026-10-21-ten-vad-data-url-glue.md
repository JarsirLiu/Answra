# Note：TEN VAD glue 经 data: URL 导入时的 wasm 路径解析崩溃

状态：已实施

## 问题

阶段 3（[面试语音 VAD 选型](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)）提交时遗留"esbuild bundle 进 utility process 的打包侧回归未验证"。本机补跑 `vad:prepare` 后首次以真实 bundle 形态（esbuild CJS、与 `build-electron.mjs` 的 worker 产物同参）执行资源加载链路：glue 经 `data:` URL 动态导入后，模块求值直接抛 `TypeError: Invalid URL`（input=`ten_vad.wasm`，base 为 data: URL）。若未修复，Agent utility process 一加载 VAD 即显式 `runtime-failed`，面试语音检测完全不工作。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/tenVadEngine.ts`（模块工厂选项）、`apps/desktop/test/tenVadBundle.test.ts` + `apps/desktop/test/vadBundleProbe.ts`（新增回归）、`.github/workflows/ci.yml`（Test 前增加 `vad:prepare` 步骤）。
- UI/进程/协议/持久化表面：无接口变更；`TenVadModuleFactory` 类型新增必填 `locateFile`（内部类型，不跨包）；worker 线协议、通道契约、资源清单格式均不变。
- 相关 Note：[面试语音 VAD 选型与 Agent 内适配器](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)。

## 根因

上一个提交的尖刀测试从磁盘直接 `import('ten_vad.js')`，此时 `import.meta.url` 是 `file://`，一切正常。而生产链路里 `tenVadEngine.ts` 把 glue 源码包成 `data:text/javascript;base64` 后 `import()`（glue 内存注入、agent 不读盘），此时：

1. glue 顶层在未提供 `locateFile` 时**无条件**执行 `new URL("ten_vad.wasm", import.meta.url)`；
2. `import.meta.url` 是 data: URL，不能作为相对路径解析的 base，`new URL` 直接抛 Invalid URL；
3. 这行求值发生在工厂函数被调用之前，`wasmBinary` 注入完全救不了——资源已就位也会崩。

本质：emscripten 胶水的资源定位子句与"经 data: URL 动态导入"这一加载形态不兼容；之前所有验证都只覆盖了 `file://` 导入形态。

## 决定

- `createTenVadEngine` 的模块工厂调用显式提供 `locateFile: () => "ten_vad.wasm"`，让 glue 走 emscripten 的注入分支；该路径字符串仅作占位，wasm 字节始终由已注入的 `wasmBinary` 提供，不会被真实读取。`TenVadModuleFactory` 类型同步把 `locateFile` 列为必填，防止未来调用点漏传。
- 新增常驻打包回归 `apps/desktop/test/tenVadBundle.test.ts`：用与 worker 产物完全相同的 esbuild 选项（CJS、node 平台、node20.9 target）打包探针 `vadBundleProbe.ts`，以 node 直接执行，完成"manifest 校验 → SHA-256 逐文件校验 → data: URL 导入 glue → WASM 实例化 → 一次 hop 推理（静音判为非语音）"全链路。资源未准备时跳过。
- CI 在 Test 前固定执行 `pnpm --filter @answra/desktop vad:prepare`，保证该回归在 CI 不因缺资源而静默跳过。

## 修复

- `apps/agent/src/interview/vad/tenVadEngine.ts`：`TenVadModuleFactory` 增加 `locateFile: (path: string) => string`；`loadModule` 传入 `locateFile: () => TEN_VAD_WASM_NAME`（模块顶部新增常量 `TEN_VAD_WASM_NAME = "ten_vad.wasm"`，附 why 注释）。
- `apps/agent/src/index.ts`：新增导出 `TEN_VAD_ONSET_THRESHOLD`（真实第二消费者是桌面端打包回归；不属于 `contracts.ts` 契约面的扩面，是从 `config.ts` 的既有常量经公共入口 `.` 暴露）。
- `apps/desktop/test/vadBundleProbe.ts`（新增）：打包回归探针入口，拥有真实 `@answra/desktop` 资源校验层 + `@answra/agent` 引擎全依赖图；检测阈值从 `@answra/agent` 取 `TEN_VAD_ONSET_THRESHOLD`，阶段 8 校准后探针自动跟进，不另立真源；成功输出单行静音判决 JSON，失败非零退出。
- `apps/desktop/test/tenVadBundle.test.ts`（新增）：esbuild 打包 + 子进程执行 + 判决断言（`voiced === false` 且概率 < `TEN_VAD_ONSET_THRESHOLD`，证明推理真实执行）。
- `.github/workflows/ci.yml`：Test 步骤前新增 `Prepare TEN VAD resources`。

## 影响表面

- 加载成功后的引擎行为、产物、协议与资源治理（清单/准备脚本/SHA-256）均不变；唯一变化是 glue 工厂选项多一个占位路径。
- 本地未跑 `vad:prepare` 时回归测试跳过（资源不进 Git，无法强制）；CI 自此固定准备资源。

## 曾考虑的替代方案

- **改为从磁盘文件路径 import glue（file:// 导入）：** mock 的是 glue 的形态依赖，让 agent 引擎重新感知文件系统路径，与"agent 不读盘、资源内存注入"的端口设计（10-20 Note `vadModuleLoader`/`TenVadSource` 端口）冲突；同时 NO_FILESYSTEM=1 下也非必要。舍弃。
- **对 glue 源码做文本补丁删掉 `new URL` 行：** 尖刀测试已验证零补丁 ESM 直载可行，仓库也把"零文本补丁"立为目标（上游 `examples/test_node.js` 需要补丁的教训在先）；补丁会随上游资源更新脆裂且违背清单式资源治理。舍弃。
- **在导入侧 try-catch 或判别 `import.meta.url` 以 data: 开头时跳过解析：** 典型吞断链路——glue 的资源定位是它的真实行为，掩盖掉等于赌后续 emscripten 升级不再有别的 `import.meta.url` 消费点。fail-open，不允许。舍弃。
- **只依赖 vitest（Node ESM）测试覆盖：** vitest 下的 import 形态与打包产物不同，本次缺陷恰恰只有 bundle 形态才暴露；不做打包侧回归就无法守住。舍弃。

## 后果与防回退

- glue 经 data: URL 导入时**必须**提供 `locateFile`；`TenVadModuleFactory` 类型已把 `locateFile` 设为必填，漏传在 typecheck 即失败。未来升级 TEN VAD 预编译资源后，打包回归会以真实 glue 重新验证该分支。
- 打包回归测试名与断言已锁定"静音 hop 判为非语音"的行为；替换引擎或改加载方式若破坏该链路，`pnpm test` 即失败。
- CI 的 `vad:prepare` 步骤是本回归的前置；从 CI 删除该步骤等于让回归回到永远 skip，评审时不得接受。

## 验证

- 修复前：bundle 探针执行报 `TypeError: Invalid URL`（input `ten_vad.wasm`、base data: URL，栈指向 glue 模块求值第 13 行）。
- 修复后：同一探针输出 `{"probability":0.248…,"voiced":false}`（真实 `resources/vad`，TEN VAD 2.1.2 / d68ab71c）。
- `pnpm --filter @answra/desktop test`：43 个测试文件 277 个用例全部通过，含新增 `tenVadBundle.test.ts`（522ms）。
- Windows 11（本机 Node v24.16.0）；utility process 实机链路（Electron 29 内动态 import 行为）归 10-20 Note 阶段 7–8 实机验证，不在此宣称。
