# Note：Agent 标准工具系统与运行时执行管理

状态：已实施

## 问题

原先 Agent 工具只有 `conversation/tools/` 下的 `Read` 与 `Grep`：工具定义是散落的对象数组，registry 直接把定义拼成 AI SDK `ToolSet`，没有统一契约、没有执行管理、没有结果预算和取消/超时收口。工具一旦增加，模型 schema、授权、执行逻辑和错误处理会继续分散。

更关键的是归属。`2026-10-26-agent-tool-registry.md` 曾决定「工具系统仅属于 conversation 域，不建立跨领域 `core/`」。这个决定在只有对话一个消费者、只有两个只读工具时成立；但产品方向要求答题、面试、会议、文档等应用都能按需申请工具集。领域之间禁止互导，如果工具系统继续留在 conversation，其他领域只能反向依赖 conversation，或者各自复制一套工具机制。

本次把工具系统提升为 Agent 底座：定义正式的工具契约和运行时执行管理；各应用只申请授权工具集，不持有工具机制，也不传工具实现。它覆盖了上述 2026-10-26 Note 中「仅属于 conversation 域」的部分决定。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/tool/contracts.ts`：`ToolId`、`ToolMetadata`、`ToolContext`、`ToolResult`、`ToolEntry`。
  - `apps/agent/src/core/tool/registry.ts`：静态注册、查询、按授权 id 生成 AI SDK `ToolSet`。
  - `apps/agent/src/core/tool/executor/`：`executeToolCall.ts`、`timeout.ts`、`resultBudget.ts`、`result.ts`。
  - `apps/agent/src/core/tool/builtin/`：`read.ts`、`grep.ts`、`workspace.ts`、`index.ts`。
  - `apps/agent/src/conversation/agent.ts`：只按 profile 授权调用 registry，不持有工具实现。
  - `apps/agent/src/conversation/profiles/registry.ts`：只声明 `ToolId[]`。
  - `apps/agent/src/host.ts`：组合根调用 `createBuiltinToolRegistry()` 注册内置工具。
  - `AGENTS.md`、`apps/agent/src/core/README.md`、`apps/agent/src/index.ts`：结构说明同步。
- UI/进程/协议/持久化表面：不新增 IPC 频道、不改变 worker 线协议；工具执行事件继续使用 `packages/shared/src/schema/events.ts` 中既有 `tool-execution-started` / `tool-execution-finished`。
- 相关 Note：
  - `../../implemented/architecture/2026-10-26-agent-tool-registry.md`（被本 Note 部分覆盖）
  - `2026-11-07-domain-agent-module-registration.md`（领域模块与工具授权的关系）
  - `2026-10-20-product-direction-and-agent-foundation.md`（底座机制与防回退红线）
  - `../../implemented/feature/2026-10-26-workspace-agent-read-tools.md`（现有 Read/Grep 行为）

## 决定

工具系统分为「机制」和「实现」两层：

```text
apps/agent/src/core/tool/          机制：跨领域唯一工具系统
  contracts.ts                     ToolId / ToolMetadata / ToolEntry / ToolContext / ToolResult
  registry.ts                      静态注册、查询、按授权生成 AI SDK ToolSet
  executor/                        验证、归一化、超时、取消、结果预算、错误归一
  builtin/                         通用工具实现：read / grep / workspace
  index.ts                         core/tool 对外唯一入口

apps/agent/src/conversation/agent.ts   申请：profile.tools 只列 ToolId
apps/agent/src/answer/agent.ts         申请：可以申请空集
apps/agent/src/interview/agent.ts      申请：可以申请空集
apps/agent/src/<domain>/tools/         领域专属工具实现，实现 core 契约
```

判断规则：

| 内容 | 归属 | 理由 |
| --- | --- | --- |
| 工具契约、注册表、执行器 | `core/tool` | 所有领域的共用机制，不属于任何产品策略 |
| `Read`/`Grep` 等通用工具 | `core/tool/builtin` | 不属于对话语义；放域里会迫使其他域依赖该域 |
| 领域专属工具 | `<domain>/tools` | 带领域语义，但实现 `ToolEntry` 契约 |
| 授权清单 | `<domain>/agent.ts` 或 profile | 领域只决定「允许哪些工具」 |
| 工具执行事件 | `packages/shared/src/schema/events.ts` | 跨进程唯一事实来源，不新增第二套事件 |

`core/tool` 不导入任何领域；领域只导入 `core/tool` 的公开入口，不导入 `builtin/` 的实现。组合根 `host.ts` 是唯一同时看见内置工具和领域模块的地方，负责注册。

工具契约：

```ts
interface ToolEntry<Input = unknown, Output = unknown> {
  readonly id: ToolId;
  readonly metadata: {
    name: string;
    description: string;
    readOnly: boolean;
    destructive: boolean;
    concurrentSafe: boolean;
    sideEffectScope: "none" | "workspace" | "network" | "session" | "userInteraction";
    timeoutMs: number;
    maxOutputBytes: number;
    resultBudget: {
      strategy: "inline" | "truncate" | "artifact";
      maxModelChars: number;
      maxModelBytes?: number;
    };
  };
  readonly inputSchema: JSONSchema7;
  handler(input: Input, context: ToolContext): Promise<Output | ToolHandlerFailure>;
  validateInput?(input: unknown): ToolHandlerFailure | undefined;
  resolveInput?(input: Input, context: ToolContext): Input | Promise<Input>;
  formatModelContent?(output: Output): string;
}
```

- `ToolId` 是品牌字符串，由 `toolId()` 工厂创建；注册表在启动装配时拒绝重复 id，授权时拒绝未注册 id，fail-closed。
- `ToolContext` 包含 `toolCallId`、`signal`、`workspaceRoot`、`runId`、`sessionId`；可选的 `readFileState` 与 `workerPaths` 由宿主/会话上下文注入。
- 采用开放 id 而不是 core 内的闭合联合，是为了让领域新增工具时不需要改 core 的类型文件；代价是失去编译期穷举，由「启动注册 + 授权 fail-closed」补偿。
- 运行时输入校验继续使用 AI SDK 的 `jsonSchema` 和 JSON Schema 约束，不引入 zod。`validateInput` 只补 schema 表达不了的业务前置。
- 结果预算默认按字符计（`maxModelChars`）；新增可选 `maxModelBytes`，两者同时配置时先按 UTF-8 字节安全截断，再按字符截断。Read 继续只使用字符/token 预算；Grep 按 ZCode 对齐同时使用 20,000 字符和 20,000 字节。`maxOutputBytes` 是投影后模型可见内容的硬上限，执行器在 `formatModelContent` 后检查，超过时返回 `output-too-large`；结构化原始输出不能因 JSON 包装被误判。Read 的独立预算见 `../feature/2026-11-09-read-tool-text-quality.md`，Grep 见 `../feature/2026-11-09-grep-ripgrep-tool.md`。

注册表与工具集申请：

```ts
const registry = createBuiltinToolRegistry();

const conversationAgent: AgentDefinition<ConversationAgentInput> = {
  id: agentId("conversation.general"),
  modelRoute: "chat",
  async prepare(input, signal) {
    const tools = registry.authorize(input.profile.tools, {
      signal,
      workspaceRoot: input.workspaceRoot,
      runId: input.runId,
      sessionId: input.conversationId,
    });
    ...
  },
};
```

「工具集」在本期就是 Agent 定义/profile 里的授权 id 列表，不是动态加载单元。只有当多个应用重复同一组清单时，才在 core 引入命名工具集；本期不预建该概念。

运行时执行管理继续使用 AI SDK 6 的 `streamText` + `stopWhen`，不自研 agent loop。执行器只包住单次工具调用：

1. `validateInput`：schema 之外的前置校验。
2. `resolveInput`：把模型入参归一化成将要执行的事实。
3. 超时与取消：`metadata.timeoutMs` 与 `context.signal` 组合；超时和用户取消统一转成结构化失败。
4. 调 `handler`：只在 Agent 进程执行，不通过 desktop 反向 RPC。
5. 结果预算：本期实现 `inline` 与 `truncate`；`artifact` 保留在类型里但显式返回 `unsupported-budget`，不静默降级。
6. `formatModelContent`：把结构化输出投影成模型消息；没有自定义投影时使用统一的文本序列化。
7. 返回 `ToolResult`：包含 `success`、`output`、`error`、`durationMs`、`modelContent`、`truncated`。失败结果的 `modelContent` 是模型可见文本，格式见 `2026-11-09-tool-business-failures-as-model-results.md`。

事件写入不双写：`core/agent/executeRun.ts:108-131` 仍用 `experimental_onToolCallStart/Finish` 写事件。执行器只返回 `ToolResult`；registry 对 `ToolFailure` 直接返回 `modelContent`，不再抛 `ToolExecutionError`。AI SDK 因此产生普通 `tool-result` 与 finish 事件；只有基础设施异常继续抛出，避免出现两套事实来源。

迁移结果：

- `conversation/tools/` 已删除；`Read`/`Grep` 迁入 `core/tool/builtin/`，工具 id 改为 `workspace.read` / `workspace.grep`。
- `ConversationToolId` 删除，profile 改为 `readonly ToolId[]`。
- `ConversationAgentInput` 增加 `runId`，由 `ConversationApplication` 的 `prepareRun` 注入。
- `host.ts` 通过 `createBuiltinToolRegistry()` 注册内置工具。

## 模块边界

- `core/tool` 是跨领域机制层：只放契约、注册表、执行器和通用工具实现，不放任何领域 prompt、profile、业务分支或产品策略。
- 领域层只能依赖 `core/tool` 的公开入口 `index.ts`；禁止从 `core/tool/builtin/*` 深导入，禁止跨领域导入 `tools/`。
- 组合根 `host.ts` 允许同时导入内置工具和领域模块，负责注册；这是唯一装配点。
- `core/tool/builtin` 使用 Agent 进程的 Node 文件 API，和现有 Read/Grep 的决定一致；桌面采集、键鼠、窗口、密钥仍留在 desktop，不进入工具系统。
- 工具事件 payload 与状态词汇仍只定义在 `packages/shared/src/schema/`；`core/tool` 不新增第二套事件或状态。
- 不引入动态 catalog、插件加载、反射、DI 容器、权限审批链路或并行调度器。

## 曾考虑的替代方案

- **维持工具系统仅在 conversation 域：** 舍弃。它会让 answer/interview 只能反向依赖 conversation 或复制一套机制，违反领域互导禁令；本次提升到 core 正是为了消除这条依赖。
- **把工具契约放进 `packages/shared`：** 舍弃。工具定义、handler 和执行上下文只存在于 Agent 进程，不跨 IPC；`shared` 只保留已经跨进程的工具体事件 schema，避免把 Agent 内部类型暴露成协议。
- **保留 `conversation/tools` 作为实现、只在 core 放接口：** 舍弃。接口与实现分离会让通用工具继续被锁在对话域，其他领域仍然无法复用。
- **结果预算只按字节计：** 舍弃。Read 的既有 20,000 字符/token 语义不能被字节统一替换；因此保留 `maxModelChars` 为主，新增可选 `maxModelBytes` 给需要对齐 ZCode 20k 模型字节的 Grep 使用。`maxOutputBytes` 仍限制投影后模型可见内容，避免结构化 JSON 包装被误算。

## 后果与防回退

- 正面后果：工具机制只有一个所有者；领域只申请授权，新增工具不再需要改 core 类型或复制 registry；执行器的校验、超时、取消和预算对所有工具一致。
- 代价：工具系统在只有一个真实消费者时进入 core，属于有意的架构提前量；后续必须用真实的第二个领域工具验证，否则应重新评估是否收回到领域层。
- 防回退：
  - 不得重新创建 `conversation/tools/` 或在领域内复制 registry；通用工具只能进 `core/tool/builtin`。
  - 领域不得从 `core/tool/builtin/*` 深导入，也不得跨领域导入 `tools/`。
  - 执行器不得写工具事件；事件唯一写入点仍是 `core/agent/executeRun.ts` 的 journal。
  - `artifact` 预算未实现前必须继续显式失败，不得静默降级为截断。
  - 未注册 `ToolId` 必须 fail-closed；新增工具必须先在组合根注册。
  - 不因本次改造引入 zod、动态插件、权限审批或并行调度器；出现第二个真实需求时单独提案。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent test`：27 个测试文件、193 个测试通过。
- 新增 `apps/agent/test/core/tool/registry.test.ts`：重复 id、未注册 id、重复模型名、授权过滤。
- 新增 `apps/agent/test/core/tool/executeToolCall.test.ts`：成功、默认序列化、`resolveInput`、`formatModelContent`、业务失败、基础设施错误、超时、取消、原始输出超限、字符/字节截断、inline、artifact 未实现。
- `apps/agent/test/core/tool/builtinTools.test.ts`：授权模型名、Read/Grep 工作区外路径与符号链接目标、无 workspace 的绝对路径、版本库目录、取消。
- `apps/agent/test/core/tool/grep.test.ts`：ripgrep 正则、glob/type、上下文、分页、multiline、`.gitignore`、点文件、版本库排除、大文件、20k 字节预算。
- `apps/agent/test/conversation/application.test.ts`：仍验证只把 profile 授权的 Read/Grep schema 发送给模型，Answer 不发送工具。
- 实机验证待桌面端真实对话中触发 Read/Grep 后补录；当前自动化证据覆盖工具契约、执行管理和模型请求投影。
