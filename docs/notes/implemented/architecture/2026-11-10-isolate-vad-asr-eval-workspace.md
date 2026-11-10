# Note：隔离 VAD/ASR 评测 workspace 并清理 Agent 无关依赖

状态：已实施

## 问题

根 `pnpm-workspace.yaml` 把 `examples/*` 纳入了 workspace。虽然 `examples/vad-asr-eval` 没有 `test` script，`pnpm verify` 不会执行评测，但根 `pnpm install` 仍会安装它的 `sherpa-onnx-node`、`vitest` 等依赖；评测资产与普通门禁的边界因此只停留在文档约定，而不是安装边界。

同时 `apps/agent` 声明了 `sherpa-onnx-node`，但 Agent 源码和测试只使用 `OfflineRecognizerModule` 端口，没有任何 import。真正使用 addon 的是 `apps/desktop`。

## 涉及范围

- 仓库/模块：`pnpm-workspace.yaml`、根 `pnpm-lock.yaml`、`apps/agent/package.json`、`examples/vad-asr-eval/`。
- UI/进程/协议/持久化表面：无；只改变 workspace 安装边界和评测运行方式。
- 相关 Note：
  - [Edit 多 hunk 展示与结构化工具输出](./2026-11-10-edit-multi-hunk-diff-display.md)
  - [工具调用卡片的统一 UI 架构](./2026-11-09-tool-call-ui-architecture.md)

## 决定

- 根 workspace 只保留 `packages/*` 和 `apps/*`；`examples/vad-asr-eval` 不再参与根安装、根 `pnpm test`、`pnpm verify` 或 CI。
- `examples/vad-asr-eval` 成为独立 pnpm workspace：新增本地 `pnpm-workspace.yaml` 和 `pnpm-lock.yaml`，依赖通过 `link:../../apps/agent` 指向仓库内 Agent 源码公开入口。
- 删除 `apps/agent` 中未使用的 `sherpa-onnx-node` devDependency；desktop 的 ASR 依赖保持不变。
- 评测入口统一改为 `pnpm --dir examples/vad-asr-eval ...`；`run-eval.mjs` / `run-eot-bench.mjs` 在示例目录内直接 `pnpm exec vitest`，不再依赖根 `--filter`。
- VAD 单元测试仍留在 `apps/agent`：它们使用合成 PCM，不读模型、不下载资产，是普通测试而非评测资产。

## 模块边界

- 根 `pnpm-workspace.yaml`：只管理 `packages/*` 和 `apps/*`；不包含评测示例。
- `apps/agent/package.json`：只声明 Agent 源码实际使用的依赖；`sherpa-onnx-node` 归 desktop。
- `examples/vad-asr-eval/`：独立 pnpm workspace；自带 lockfile，通过 `link:../../apps/agent` 读取 Agent 公开入口。
- `examples/vad-asr-eval/*.mjs`：只编排资产校验和本地 vitest，不参与根 workspace 的脚本调度。
- 根 `pnpm test` / `pnpm verify`：不加载示例测试文件，也不触发模型或样本下载。

## 曾考虑的替代方案

- **保留 `examples/*` 在根 workspace，只从测试脚本排除：** 舍弃。`pnpm install` 仍会安装评测依赖，无法解决“常规安装被评测依赖污染”的根问题。
- **删除 `examples/vad-asr-eval`：** 舍弃。它是真实链路 VAD/ASR 的人工评测入口，仍有保留价值。
- **把示例移到仓库外：** 舍弃。会失去与 `@answra/agent/evaluation` 同版本的示例和 CI 外的可复现入口。
- **在根安装里忽略 `sherpa-onnx-node`：** 舍弃。desktop 的本地 ASR 运行时需要它，不能为了评测 clean install 破坏桌面端。
- **把 VAD 单测也移出常规门禁：** 舍弃。单测是纯内存算法验证，成本低且能防止 VAD 状态机回归；真正需要隔离的是模型/样本资产。

## 后果与防回退

- 正面后果：根安装和常规门禁不再包含评测 workspace 的依赖；`pnpm test` 不会再看到 VAD/ASR 评测文件；`apps/agent` 的依赖表与实际 import 一致。
- 代价：首次运行评测必须先在 `examples/vad-asr-eval` 内 `pnpm install`；示例依赖变化时需要更新它自己的 lockfile。
- 代价：`link:../../apps/agent` 的传递依赖依赖根 workspace 已安装；在仓库内使用时，先完成根 `pnpm install` 再安装/运行示例。
- 防回退：不得把 `examples/*` 重新加入根 `pnpm-workspace.yaml`；不得在根 `pnpm test` 中直接运行示例评测；不得让评测资产下载进入 `apps/agent` 单测；不得把 `sherpa-onnx-node` 重新加到未使用它的 Agent 包。

## 验证

- 根 `pnpm install` 的 workspace scope 从 6 个包减少为 5 个；`pnpm -r list --depth -1` 不再包含 `@answra/vad-asr-eval`。
- 根 `pnpm-lock.yaml` 移除了 `examples/vad-asr-eval` importer 和 `apps/agent` 的 `sherpa-onnx-node` devDependency。
- 示例目录独立安装通过，`pnpm --dir examples/vad-asr-eval exec vitest run eot-bench-metrics.test.ts` 通过（3 项）；`chain-eval.test.ts` 在未设置 `ANSWRA_ASR_EVAL_RUN=1` 时正常跳过。
- 根 `pnpm lint`、`pnpm typecheck`、`pnpm notes:check`、`pnpm architecture:check` 通过。
- 根 `pnpm verify` 仍受既有 shell 会话用例时序问题影响，与本次 workspace 隔离无关；常规 VAD/ASR 评测资产不再进入根门禁。
