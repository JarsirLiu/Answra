# 仓库协作规范（AGENTS.md）

面向人类协作者与 AI 助手的仓库结构与架构约定。参照 ZCode 的 monorepo 标准维护，目标是支持团队长期迭代，而非一次性原型。

## 包结构与依赖方向

```text
@answra/shared  ←  @answra/ui  ←  @answra/desktop(renderer)
                                    ↑
@answra/shared  ←  @answra/desktop(main / preload)
@answra/shared  ←  @answra/agent  ←  @answra/desktop(main)
```

- 依赖必须单向，禁止环（`pnpm architecture:check` 强制）。
- 跨包导入只允许使用目标包 `package.json` `exports` 声明的入口；禁止深导入、禁止相对路径跨包（架构脚本强制）。
- 新增共享能力时：类型/常量进 `shared`，纯 UI 进 `ui`，平台能力进 `desktop`，与平台无关的 Agent 运行时进 `agent`。
- `apps/` 只放可启动单元（`desktop` 是 Electron 壳，`agent` 由 utility process 拉起并保留独立为常驻 sidecar 的可能）；纯库放 `packages/`。

## 进程边界（apps/desktop）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main` | 窗口管理、生命周期、按领域拆分的 IPC handler（`src/main/ipc/*Ipc.ts`） | 可用 electron / node 内置模块 |
| `src/preload` | `contextBridge` 暴露唯一 `window.answra` API 面 | 只做转发，不放业务逻辑 |
| `src/renderer` | 薄壳：挂载 `<FloatingBarApp/>` | 禁止 import electron / node 模块 |

## Agent 运行时（apps/agent）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/worker` | 线协议 `AgentCommand` / `AgentFrame`，跨进程唯一契约 | 只放协议类型；命令/帧变更必须同步 desktop worker |
| `src/conversation` | 会话运行时、会话存储端口与内存适配器 | 不依赖 Electron / React；新增领域平级加目录 |
| 平台能力 | 采集、键鼠注入、窗口、密钥等实现留在 desktop | 运行时只持有端口，实现由 desktop 注入 |

入口规则：desktop 只从 `@answra/agent`（`exports` 的 `.`）导入；本包不产出独立构建产物，由 desktop 的 `build:electron` 一并 bundle。

仓库根目录 `examples/vad-asr-eval/` 是可选真实样本 VAD/ASR 评测 workspace：原句与链路转录并排供人工审阅，不生成回答；经 `@answra/agent/evaluation` 公开入口调用，不进入常规门禁，下载资产和 CSV 产物不入 Git。

## IPC 约定（三层类型安全）

1. 频道常量与请求/响应类型映射只写在 `packages/shared/src/channels.ts`，命名 `answra:<域>:<动作>`。
2. main 侧 handler 按领域一个文件，注册前用 `isWindowFromSender` 校验来源。
3. preload 消费 ChannelMap 类型；renderer 通过 `DesktopBridge` 接口访问，测试注入 mock bridge。

## 环境变量

- 变量名只允许在 `packages/shared/src/env.ts` 定义一次；`.env.example` 逐项注明用途与是否 secret。
- 运行时读取统一走类型化函数（如 `parseAnswraEnv`），禁止散落 `process.env.XXX`。

## 内置输入法资源

- librime 和 `answra-rime-host` 使用预编译资源，不在 `pnpm dev`、`pnpm bootstrap` 或打包时编译。
- 二进制和词库不提交 Git；放在 `apps/desktop/resources/rime/`，并在打包前执行 `pnpm --filter @answra/desktop ime:prepare`。
- Windows 使用 MSVC x64 运行库，macOS 使用 universal 运行库；发布包只携带目标平台资源。
- 下载来源与 SHA-256 固定在 `apps/desktop/native/rime-resources.json`；helper 使用固定 GitHub Release tag 和随 release 发布的 `SHA256SUMS` 校验。资源准备完成后再执行 `pnpm bootstrap`、`pnpm dist:win` 或 macOS 打包命令。
- `luna_pinyin_simp` 依赖 `rime-luna-pinyin`、`rime-essay` 和 librime `deps` 包中的
  `share/opencc/*`；英文联想使用上游 `BlindingDark/rime-easy-en` 的
  `easy_en.schema.yaml`、`easy_en.yaml`、`easy_en.dict.yaml`，并由
  `native/rime-data/luna_pinyin_simp.custom.yaml` 接入。更新资源时必须同步更新来源、版本和
  SHA-256，并重新执行 `ime:prepare`，不能只替换 DLL。

## 质量门禁

- `pnpm verify` = biome lint + 全包 typecheck + vitest + 架构守护；其中 Note 检查走 `pnpm notes:hint`（只提示、不阻断本地提交）；husky pre-push 自动执行。
- `pnpm notes:check`（严格）保留给 CI 与发布前：缺少配套 Note、Note 格式不完整或本地链接失效时失败。CI（`.github/workflows/ci.yml`）以 `--base` 比较目标分支执行严格模式。
- 提交前自检与门禁执行要点（范围意图、Note 配对、全量门禁、diff 自审、秘密与工件、Conventional Commits）收编在 `.agents/skills/answra-code/SKILL.md` 终篇，不再单设 skill。
- 写代码与评审的工程规范见 `.agents/skills/answra-code/SKILL.md`：前置条件闸门（事实不足必须停下并客观告知）、代码落层判断、契约与类型纪律、状态与行为的显式来源（禁推演状态）、防御性代码预算、魔法值清零、规模预算（函数/文件/目录）、co-location、可读性、并行模块纪律。
- 每个 UI 行为变化在 `packages/ui/test/` 补测试；main 进程逻辑后续用 node:test/vitest 覆盖。
- 提交信息使用 Conventional Commits，标题简明。

## 文档

- `docs/notes/` 是方案、功能决策、缺陷复盘、架构约束和流程经验的唯一长期存放处；`docs/` 根目录不新增平铺专题文档。
- 功能新增/删除、用户行为变化、有复盘价值的缺陷、跨模块契约、架构/依赖/持久化/测试策略/工具流程变化，必须在同一变更中新增或更新 Note。纯格式、typo 和纯机械重命名可豁免。
- 每项独立功能或决策分别留痕。Note 必须写问题、影响范围、决定、真实替代方案及舍弃理由、后果，以及验证证据或防止重复踩坑的约束。
- Note 按 `proposed`、`implemented`、`rejected`、`archived` 生命周期和功能类别归档；格式与转换规则见 `docs/README.md` 和模板。
- AI 开发流程见 `.agents/skills/answra-change/SKILL.md`。本地 `pnpm verify` 只提示缺少配套 Note（`pnpm notes:hint`），不阻断提交；严格失败判定（缺少 Note、格式不完整、本地链接失效）由 `pnpm notes:check` 与 CI 执行。
- 产品方向与 Agent 底座规划见 `.agents/skills/answra-vision/SKILL.md`（正文提案在 `docs/notes/proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md`）。新增能力域、新功能规划或跨域能力（工具、打断、存储、媒体流）设计前先核对。
- 结构性变更同时同步本文件、Note 和 README 仓库结构表。
