# Note：本地 ASR 引擎在桌面侧的装配（依赖、打包与组合根胶水）

状态：已实施

## 问题

[本地内置 ASR 路线](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md) 的模型资源已准备、Electron utility process 加载已实证（[资源准备 Note](../process/2026-10-21-asr-paraformer-resource-prep.md)），但产品里仍然没有引擎：

1. desktop 未引入 `sherpa-onnx-node` 依赖，electron-builder 不携带模型资源、也不解包平台 DLL；
2. agent 的 `LocalParaformerAdapter` 只有评测 harness 消费，桌面侧不存在把 addon 适配成 `OfflineRecognizerModule` 的实现；
3. [资源准备 Note](../process/2026-10-21-asr-paraformer-resource-prep.md) 当时把打包 external/unpack 配置与组合根注入推迟到"接线批次"，理由是提前配置只会让安装包凭空多 82MB、产生无消费者的死配置。

用户（产品方向最终决定者）裁定：先把引擎依赖在桌面侧立起来，进程宿主的 provider 接线（装配 → transcript-event）随后单独批次推进。因此本批必须回答：引擎装配如何先于宿主接线落地而不变成死代码预置。

## 涉及范围

- `apps/desktop/package.json`：`dependencies` 新增 `sherpa-onnx-node` 1.13.8（与评测 workspace 同版）；`build` 字段新增 `asarUnpack` 规则与 `extraResources`（`resources/asr` → `asr`）。
- `apps/desktop/scripts/build-electron.mjs`：worker 产物 `external` 新增 `sherpa-onnx-node`。
- `apps/desktop/src/main/interview/asrRecognizer.ts`（新增）：manifest 读取、SHA-256 流式校验、sherpa 适配胶水 `createParaformerRecognizerModule`。
- `apps/desktop/src/main/sherpaOnnxNode.d.ts`（新增）：sherpa-onnx-node 1.13.8 的最小类型声明面（该包无自带类型，先例是 koffi 自带 `index.d.ts` 的静态导入形态）。
- `apps/desktop/test/asrRecognizer.test.ts`、`apps/desktop/test/asrBundleProbe.ts`、`apps/desktop/test/asrBundle.test.ts`（新增）。
- `apps/agent/src/index.ts`：核心出口补 `OfflineRecognizerModule` / `OfflineRecognizerRecipe` / `OfflineRecognizerSession` 类型导出。
- `.github/workflows/ci.yml`：Test 前新增 `asr:prepare`。

相关 Note：[本地内置 ASR 路线](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md)、[LocalParaformerAdapter](2026-10-21-local-paraformer-adapter.md)、[资源准备与 utility process 加载验证](../process/2026-10-21-asr-paraformer-resource-prep.md)、[TEN VAD 选型与打包回归](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)。

## 决定

### 依赖与打包

- `sherpa-onnx-node` 固定 1.13.8 进 `dependencies`（koffi 同型）；平台二进制来自可选依赖（Windows 取 `sherpa-onnx-win-x64`），lockfile 已有全部平台条目。
- `extraResources` 携带 `resources/asr`（模型 82MB、tokens、许可原文、运行时 manifest）；`asarUnpack` 显式展开 sherpa 全部平台包——electron-builder 只自动解包 `.node`，`onnxruntime.dll` 等 DLL 不解包必然加载失败。
- worker 产物 `external` 加 `sherpa-onnx-node`：native addon 不可打包，运行时从 node_modules 解析。当前 worker bundle 尚无该 import（宿主接线随后），规则先行声明，接线批到达即生效。

### 组合根胶水（无消费者的疑问由此化解）

- 与 `tenVadResources.ts` 同形：读 `resources/asr/manifest.json` → 逐文件 SHA-256 校验（模型 82MB 走 `pipeline(createReadStream, hash)` 流式哈希，不整块进内存）→ 返回 `{ module, recipe }`；`numThreads` 用常量 4（与评测 harness 同点）。
- `OfflineRecognizer` 配置形状固定为 `modelConfig` 内含 `tokens`/`numThreads`/`provider`/`debug`——资源准备 Note 的防回退约束，写顶层会报 `tokens: '' does not exist`。
- 校验或 addon 加载失败直接抛错并提示 `asr:prepare`（fail-closed），不回落任何替代实现。
- **非死代码的成立方式**：胶水由打包回归第一时间消费——`asrBundle.test.ts` 用与 `build-electron.mjs` worker 产物同参的 esbuild 把 `asrBundleProbe.ts` 打成 CJS、以 node 直跑（ten-vad 的 `vadBundleProbe.ts` 先例形态），真实加载 82MB 模型并完成一次解码，证明"依赖进桌面包 → addon 运行时解析 → 模型校验加载 → 解码"整条链路成立。宿主接线批次复用同一入口，产品与回归同路径。
- agent 核心出口补类型导出：desktop 只能从 `@answra/agent` 的 `exports` 入口导入（架构守护强制），胶水的 `OfflineRecognizerModule` 类型由此获得合法出口；`RecognizerSource` 组合根端口与 host 选项本批不动。

### 与 tenVadResources 的重复边界（并行开发收敛点）

`asrRecognizer.ts` 与 `tenVadResources.ts` 各自持有形状相近的 manifest 读取/校验逻辑（约 40 行），**刻意不抽公共 helper**：二者清单结构与读取形态不同（ASR 是 82MB 流式哈希、TEN VAD 是小文件整块读入喂 wasm），且资源领域如今只有这两个实现；强行抽公共层会把两个独立资源域耦在同一个工具文件上，并行改动时互相牵连。收敛条件：出现第三处同型校验（如云端网关资源的 SHA 校验），再抽 `resourceManifest` 公共层落地。

## 影响表面

- Desktop 依赖与 Windows/macOS 发布产物：本地 Paraformer addon、模型资源目录和 native DLL 解包规则。
- Agent utility process：由 Desktop 组合根装配本地 recognizer，并通过 worker bundle external 解析 addon。
- CI 与开发验证：ASR 模型资源准备及真实模型 bundle 探针解码。

## 曾考虑的替代方案

- **引擎装配与宿主接线同批推进（先前方案）**：用户驳回——先在桌面侧把引擎立起来；胶水改由打包回归先消费的先例形态，避免无消费者的死代码。
- **desktop 不 import agent 类型、按评测注释自行声明形状**：类型无真实出口，desktop 的 import 会违反跨包只走 `exports` 入口的架构约束；给 agent 核心出口补三条类型导出即可，不动 host。
- **`createRequire(import.meta.url)` 惰性 require addon（评测 harness 形态）**：CJS bundle 中 `import.meta.url` 无 shim，探针运行期 `ERR_INVALID_ARG_VALUE`；改为静态 import（koffi 同型），vitest/打包两种形态实测都通。
- **整块 `readFile` 校验 82MB 模型（ten-vad 的 readFile 形态）**：瞬时多占约 80MB 内存却零收益；改流式哈希。
- **electron-builder 自动处理平台包拷贝**：它只自动解包 `.node`，DLL 不解包 addon 加载必炸；显式 `asarUnpack`。

## 后果与防回退

**后果**

- CI 每次多下载 82MB 模型资源（[资源准备 Note](../process/2026-10-21-asr-paraformer-resource-prep.md) 曾以"无 CI 回归消费"为由按下 `asr:prepare` 进 CI——该前提已因回归落地而翻转）。
- `dist:win` 真实打包尚未实跑：包内 asr 资源存在性、asar 解包 DLL 的加载，待打包批次实证；macOS `DYLD_LIBRARY_PATH` 同为遗留项。
- worker bundle 的 external 声明目前不产生产物差异（无 import），宿主接线批到达即生效。

**防回退约束**

- `createParaformerRecognizerModule` 的入口签名（`resourceRoot → Promise<{ module, recipe }>`）保持稳定：宿主接线批必须复用该入口，不得另写旁路实现，保证回归与产品同路径。
- 升级 `sherpa-onnx-node` 版本时必须同步复测探针与 d.ts 声明面，不得只改版本号。
- 资源清单（`native/asr-resources.json`）或模型文件变更必须重跑 `asr:prepare` 并重算 SHA-256，运行期校验失败不得静默回落。

## 验证

- 2026-10-21 `pnpm --filter @answra/desktop vitest run`：`asrRecognizer.test.ts` 5 条（清单缺失/结构不合法/条目缺失/哈希不匹配 fail-closed + 通过哈希返回装配参数）、`asrBundle.test.ts` 1 条（真实 82MB 资源 + worker 同参 CJS bundle 探针解码通过，探针 2.9s）全绿。
- 2026-10-21 探针曾实测出 `import.meta.url` 在 CJS bundle 缺 shim 的问题（`ERR_INVALID_ARG_VALUE`），改为静态 import 后通过——该证据支撑"静态 import + external"的打包形态决定。
- 2026-10-21 仓库 `pnpm lint` / `typecheck` / `architecture:check` / `notes:check` 全绿。
