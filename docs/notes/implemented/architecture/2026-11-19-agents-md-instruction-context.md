# Note：AGENTS.md 指令上下文

状态：已实施

## 问题

仓库长期把项目约束写在 `AGENTS.md`。此前 Agent 只在编码 prompt 里提示"目录中存在 `AGENTS.md` 时先阅读"，但没有自动读取：模型必须先发起 `Read` 才能看到内容，在没有工具调用或工具被裁剪的回合里，项目约束等于不存在。

opencode 的做法是全局 `AGENTS.md` + 从当前目录向上发现的 `AGENTS.md` 共同进入系统上下文，并把发现边界限制在项目根内。本仓库缺少这一步，导致 CLI 编码与会话型工作区助手启动时都看不到用户已经写下的项目规则。

## 涉及范围

- 代码/模块：
  - 新增 `apps/agent/src/core/instruction/`：契约、发现/读取、渲染。
  - `apps/agent/src/coding/agent.ts`、`conversation/agent.ts`：准备模型请求时拼接 AGENTS.md。
  - `apps/agent/src/coding/bot.ts`、`conversation/bots/`：把加载器从宿主传进 Bot。
  - `apps/agent/src/host.ts`、`coding/host.ts`：接收宿主注入的全局指令文件路径。
  - `apps/cli/src/config/instructionFile.ts`、`main.ts`、`remote/host/commandPort.ts`：CLI 与 remote host 解析 `~/.answra/AGENTS.md`。
  - `apps/desktop/src/main/agent/agentWorkerHost.ts`、`conversation/worker.ts`、`workerTransport.ts`：utility process 启动参数传入用户级 `AGENTS.md` 路径。
- UI/进程/协议/持久化表面：
  - 不改 `worker/protocol.ts` 命令形状；只新增 worker 进程启动参数。
  - 不改 transcript、事件、renderer 或配置文件。
- 相关 Note：
  - [Agent Skill 目录扫描与按需加载](../../proposed/architecture/2026-11-17-agent-skill-catalog-and-loading.md)（同为本地可信内容注入，但 skill 是索引按需加载，AGENTS.md 是每回合常驻）

## 决定

### 1. 指令来源与发现边界

每回合加载两类文件：

1. 用户级全局文件：宿主注入的 `<Answra 配置目录>/AGENTS.md`。
2. 项目级文件：从当前工作区向上找到最近的 `.git` 作为项目根，读取项目根到当前工作区每一层的 `AGENTS.md`。

没有 `.git` 时只读取工作区自身的 `AGENTS.md`，不继续向上扫描任意父目录。这样既支持在仓库子目录启动 CLI 时读到仓库根规则，也避免把工作区之外的随机父目录指令注入模型。

文件按“全局 → 项目根 → … → 工作区”排序；越靠后的文件越具体。同一绝对路径只读取一次（Windows 路径大小写不敏感）。空文件保留，模型仍能看到路径；缺失文件视为不存在。

### 2. 加载时机与宿主边界

`@answra/agent` 不 import `@answra/config`，也不猜测配置目录。宿主只注入全局文件绝对路径：

- CLI 与 remote host 使用 `resolveDefaultConfigDir()/AGENTS.md`。
- desktop worker 由主进程传入 `app.getPath("userData")/AGENTS.md`。

加载器按 prepare 调用逐次读盘，不建缓存、不监听文件变化。用户在下一回合就能看到修改后的 `AGENTS.md`；代价是每回合有少量本地读盘。单文件超过 256 KB 跳过并告警，避免异常大文件撑爆 system prompt。

### 3. 注入范围

- coding Agent 与 conversation Agent 注入；两者都有工作区读写工具，项目规则是执行约束。
- interview rehearsal、interview intake、screenshot answer 不注入：这些领域的上下文是候选人资料或截图，不应被项目编码规则污染。

渲染为独立 system 片段，位置在工作区环境之后、skill 索引之前：

```text
## AGENTS.md

以下内容来自本地 AGENTS.md，按项目根到当前工作区排序；越靠后的文件越具体，冲突时优先遵守。

Instructions from: <绝对路径>
<文件原文>
```

### 4. 明确不做

- 不读 URL、glob、`instructions` 配置数组；首版只支持固定文件名 `AGENTS.md`。
- 不做文件监听与实时热更新；修改在下一回合生效。
- 不把 AGENTS.md 内容写入 transcript；它只属于每次请求的 system 上下文。
- 不把该能力扩展到 interview/answer 领域。

## 模块边界

```text
apps/agent/src/core/instruction/
  contracts.ts  InstructionFile / InstructionLoader / 单文件大小上限
  catalog.ts    全局文件 + 项目根发现 + 逐层读取 + 去重
  guidance.ts   文件数组 -> system prompt 片段
```

- `core/instruction` 只做本地磁盘事实与渲染，不 import 领域、不读配置、不判断哪类 Bot 该注入。
- 注入策略留在 `coding/`、`conversation/` 的 Agent 定义；宿主只解析路径。
- 该模块进入 `core` 是因为 coding 与 conversation 两个消费者共享同一发现/渲染语义，符合"第二消费者出现后再抽底座"的约束。

## 曾考虑的替代方案

- **只在 coding prompt 里要求模型自己 `Read` AGENTS.md：** 舍弃。模型不调用工具时看不到约束，且每回合重复读取浪费 token；现有提示只能作为兜底。
- **从工作区一直扫描到文件系统根：** 舍弃。会把工作区之外、与项目无关的父目录指令注入请求，边界不可解释。
- **以工作区自身为唯一发现边界：** 舍弃。CLI 常在仓库子目录启动，读不到仓库根 `AGENTS.md`，与用户实际项目结构冲突。
- **复制 opencode 的 SystemContext 注册表、Effect 与服务端 URL/glob 来源：** 舍弃。本仓库没有 Effect，也没有远程指令需求；只保留"全局 + 项目向上 + 明确边界"的语义。
- **全局常量写死 `~/.answra/AGENTS.md`：** 舍弃。agent 是平台无关包，配置目录必须由 CLI/desktop 注入；CLI 与 desktop 的 userData 路径要由各自组合根负责。
- **加载一次并永久缓存：** 舍弃。AGENTS.md 是用户随时会改的规则文件，缓存会让修改在长时间会话里失效；逐次读取成本可控。

## 后果与防回退

- system prompt 增加指令文本；`AGENTS.md` 越长，每回合上下文成本越高。超过 256 KB 的文件被跳过而不是截断，避免半截规则被误读。
- 只在发生本地读盘错误或超大文件时告警；文件不存在是正常状态，不告警。
- 发现边界依赖 `.git`。没有 `.git` 的项目需要把 `AGENTS.md` 放在工作区根；这是有意接受的限制。
- 不得把 AGENTS.md 内容写进 transcript 或持久化状态；它必须保持每回合从磁盘事实重建。
- 不得在 agent 包内引入配置目录或 Electron 路径；新增宿主必须自己注入全局文件路径。

## 验收标准

- 可观察结果：
  - 在工作区根写 `AGENTS.md` 后，下一回合的 coding/conversation system prompt 出现 `Instructions from: <路径>` 与文件原文。
  - 仓库子目录作为工作区时，仓库根与中间层 `AGENTS.md` 按根到工作区顺序出现。
  - 全局 `AGENTS.md` 在工作区没有项目文件时仍然出现。
  - interview/answer 的 system prompt 不出现项目指令。
- 自动化验证：
  - 全局 + 多层项目文件顺序、`.git` 边界、无 `.git` 不越界、空文件、缺失全局文件、同路径去重、渲染顺序。
  - coding 与 conversation Agent 的 system prompt 端到端包含工作区指令。
- 需要的实机验证：
  - CLI 在仓库根与子目录各启动一次，确认看到对应层级指令。
  - desktop 修改 `app.getPath("userData")/AGENTS.md` 后下一回合生效。
  - 打包后的 desktop worker 能收到新增启动参数。

## 验证

- `apps/agent/test/core/instruction/instructionContext.test.ts`：全局 + 多层项目文件顺序、`.git` 边界、无 `.git` 不越界、空文件、缺失全局文件、去重、超大文件跳过与渲染顺序。
- `apps/agent/test/core/instruction/instructionPromptIntegration.test.ts`：coding 与 conversation Agent 的 system prompt 均包含工作区 `AGENTS.md` 原文与路径。
- `pnpm --filter @answra/agent exec vitest run test/core/instruction`：2 文件 / 8 项通过。
- `pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/desktop typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check` 通过。
- 实机 CLI/desktop 与打包 worker 参数尚未验证；当前完成的是自动化行为验证。

## 风险

- `AGENTS.md` 是本地磁盘内容，但不等于可信内容：打开不受信任的仓库时，仓库里的 `AGENTS.md` 会成为自动注入的 prompt injection 面。首版没有项目级关闭开关；这是明确接受的风险，后续如需要应在宿主层提供显式 opt-out，而不是让 agent 猜。
- 全局文件与项目文件规则冲突时依赖模型按"越靠后越具体"理解和取舍；我们不做自动合并或冲突检测。
- 每回合读取多个层级的文件会增加少量 I/O；若后续出现明显延迟，再评估按 mtime 缓存，而不是提前引入监听器。
- 只识别大写 `AGENTS.md`；大小写不敏感文件系统上用户写成其他大小写时不会加载。
