# Note：Agent 运行时改名与领域分层

状态：已实施

## 问题

`apps/app`（包名 `@answra/app`）是团队并行的主要工作面，但它的名字与组织都在误导后续开发：

1. **名字**：`apps/` 按约定只放可启动单元，目录再叫 `app` 等于同义重复；包内没有应用，只有一套不依赖 Electron 的 Agent 运行时（会话、模型调用、worker 线协议）。产品路线要继续加转写、触发判断、工具注册、`/go`、`/image` 等能力，这个名字会把它变成杂物间，也让"这个包到底能不能依赖 Electron"这种问题反复出现。
2. **组织**：`src/` 下四个文件平铺，没有公共入口的边界含义（`src/index.ts` 只转发协议类型，实现却要走 `./runtime` 子路径）；对话运行时和会话存储混在同一层，新领域没有位置可放。
3. **虚构的构建步骤**：`pnpm --filter @answra/app build` 产出的 `dist/runtime.cjs` **没有任何消费方**。desktop 的 `build:electron` 直接把 `src/main/conversation/worker.ts` 当 entry、连带把 `@answra/app` 的 TypeScript 源码一起 bundle 进 `out/main/conversation/worker.cjs`；`shared`、`ui` 同样是无构建的源码包。

## 涉及范围

- 代码/模块：`apps/app` → `apps/agent`（含 `src/index.ts`、`src/worker/protocol.ts`、`src/conversation/{runtime,store}.ts`、`test/conversation/*`）、`apps/desktop/src/main/conversation/{worker,agentService,conversationIpc}.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/package.json`、`scripts/architecture/architecture-check.mjs`、`README.md`、`AGENTS.md`。
- UI/进程/协议/持久化表面：**无行为变化**。worker 线协议的形状不变（仅类型名 `AppCommand`/`AppFrame` → `AgentCommand`/`AgentFrame`），IPC 频道仍是 `answra:conversation:*`，持久化文件不变；变化只是包路径、导入入口、目录归属与主进程内部类名。
- 相关 Note：[功能边界与本地运行时](2026-10-11-feature-boundaries-and-local-runtime.md)、[后端拥有会话与内存仓储](2026-10-12-conversation-memory-store-port.md)（文中 `apps/app` 为当时路径，保留不动）、[拒绝：本地 app service 与 agent 边界](../../rejected/architecture/2026-10-11-local-app-service-and-agent-boundary.md)。

## 决定

- 目录与包名统一为 `apps/agent` / `@answra/agent`，与运行时职责同名；desktop 主进程侧的 `AppService` 同步改名 `AgentService`（`appService.ts` → `agentService.ts`），日志前缀 `[agent-service]`。
- 包内按领域切分目录，公共入口只有一个：

  ```text
  apps/agent/src/
    index.ts                公共入口：desktop worker 的唯一导入面
    worker/protocol.ts      线协议 AgentCommand / AgentFrame（跨进程唯一契约）
    conversation/runtime.ts 会话运行时：模型调用、运行生命周期、取消
    conversation/store.ts   会话存储端口 + 内存适配器
  ```

  未来的转写、工具注册、触发判断各自平级加目录（`transcription/`、`tools/`、`triggers/`），不预先创建空目录。
- `exports` 只保留 `.`，删掉 `./runtime` 子路径入口；`worker.ts` 从 `@answra/agent` 一处导入协议类型与运行时。
- 删除无人消费的构建：去掉 `apps/app/scripts/build.mjs`、`build` 脚本与 `esbuild` devDependency，并去掉 desktop `dev`/`build` 里的 `pnpm --filter @answra/app build`。
- 保留在 `apps/` 而非 `packages/`：该运行时由 Electron utility process 拉起、将来可能独立为常驻 sidecar，属于"可启动单元"；`packages/` 留给纯库。

## 模块边界

- `apps/agent`：平台无关的 Agent 运行时，允许使用 `node:` 内置模块与模型 SDK，**禁止**依赖 Electron 与 React。
- `apps/agent/src/worker`：只放线协议类型；命令/帧变更必须同时改 desktop 的 worker 适配。
- `apps/agent/src/conversation`：会话运行时与存储端口；新增领域在本包内平级加目录，不把领域知识塞进 `worker`。
- `apps/desktop/src/main/conversation`：`AgentService` 负责拉起 worker、命令/帧转发、模型配置与密钥安全存储；`worker.ts` 是 Electron 专属的进程入口与命令分发，平台能力（采集、键鼠注入、窗口）继续留在 desktop 并通过端口注入。
- `packages/shared`：IPC 契约与领域类型，不依赖 agent；`packages/ui` 不感知 agent 内部结构。
- 架构守护：`node:`/`electron` 白名单由硬编码的 `apps/app/src/` 改为 `apps/agent/src/`。

## 曾考虑的替代方案

- **搬到 `packages/agent`：** 语义上"无构建的源码库"更贴合当前形态，但会松动"`apps/` = 可启动单元"这条约定（它有自己的进程与将来的 sidecar 路线），并且要为此改架构脚本的 node 白名单，收益不如保留在 `apps/`。
- **只改名不分层：** 名字对了但四个文件继续平铺，下一个领域仍然无处安放，问题会在加转写时重复出现。
- **保留 `@answra/app/runtime` 子路径入口：** 少一次导入改动，但公共面变成两个，跨进程调用的合法入口说不清楚。
- **保留 `dist/runtime.cjs` 构建以"以后当 sidecar 用"：** 该 bundle 只是导出一个类，不是可运行进程；真要 sidecar 时需要新的进程入口，届时再加构建更清楚。
- **连 `ConversationRuntime` 一起改名（如 `AgentRuntime`）：** 类名是领域内名称且已位于 `conversation/` 目录，改名只会扩散到测试与文档而无收益。

## 后果与防回退

- `@answra/app`、`apps/app`、`AppService`、`AppCommand`/`AppFrame` 不再存在；新代码与文档不得再使用这些名字。历史 Note 里带日期的旧路径保留，不回改。
- desktop 只从 `@answra/agent` 的 `.` 入口导入；`apps/agent` 不新增构建产物，也不允许被 desktop 之外（尤其 renderer / ui）导入。
- 该包不得引入 Electron / React 依赖；平台能力只能通过端口注入，否则架构守护与"能跑在任何 Node 宿主"的前提一起失效。
- 新增领域目录时同步更新 `AGENTS.md` 的运行时表格与 README 结构表；`src/worker` 协议变化必须同时更新 desktop worker 与 `AgentService`。

## 验证

- 移动使用 `git mv`，历史保留；`pnpm install` 后 `pnpm-lock.yaml` 中 workspace 名更新为 `@answra/agent`。
- `pnpm verify` 全绿：lint、docs、typecheck、test（agent 2 文件 7 项、ui 29 文件 209 项、desktop 27 文件 159 项）、architecture。
- `pnpm architecture:check` 覆盖新路径白名单；`pnpm build` 在无 agent 构建脚本的情况下仍通过（desktop 单独 bundle worker 与 agent 源码）。
- 未做：真实 Electron 启动验证（`pnpm dev` 后 agent worker 是否正常起来）；改名后首次运行需实机确认 `[agent-service] started` 日志与截图问答链路。
