# Note：Bot 注册中心架构重构

状态：提案

## 问题

当前 bot 组织结构存在职责混乱和扩展性问题：

1. **领域混淆**：`conversation/profiles/registry.ts` 的 `CHAT_PROFILES["general-chat"]` 实际是 general bot 的 system prompt 和工具清单，但 coding bot 的 prompt 却放在独立的 `coding/policy.ts`，两者应该平级却分散在不同领域目录下。
2. **注册分散**：bot 定义散落在 `conversation/bots/`、`coding/bot.ts` 等位置，没有统一的发现机制；新增 bot 需要修改多处（agent 定义、bot 工厂、composition.ts、host 装配）。
3. **职责不清**：`conversation/` 既是领域应用层（会话编排），又是 bot 定义的容器；`conversation/agent.ts` 定义的 `GENERAL_IDENTITY` 与 `conversation/bots/general.ts` 的工厂分离。
4. **扩展困难**：未来 interview、answer、meeting 等 bot 如果继续按当前模式，会在各自领域目录下重复 bot 定义与注册逻辑。

## 涉及范围

- 代码/模块：
  - 新增 `apps/agent/src/bots/`：统一 bot 注册中心，包含 `general/`、`coding/`、`interview/` 等子目录
  - 移动 `conversation/agent.ts` → `bots/general/agent.ts`
  - 移动 `conversation/profiles/` → `bots/general/profile.ts`
  - 移动 `conversation/bots/` → 删除（逻辑合并到 `bots/general/bot.ts`）
  - 移动 `coding/agent.ts` → `bots/coding/agent.ts`
  - 移动 `coding/policy.ts` → `bots/coding/policy.ts`
  - 移动 `coding/bot.ts` → `bots/coding/bot.ts`
  - 调整 `composition.ts`：从 `bots/registry.ts` 导出 bot 工厂
  - 调整 `host.ts`、`coding/host.ts`：使用 registry 创建 bot
- UI/进程/协议/持久化表面：无变化，只是内部模块重组织
- 相关 Note：
  - `docs/notes/implemented/architecture/2026-10-20-product-direction-and-agent-foundation.md`（产品支柱与架构组织）
  - `docs/notes/proposed/architecture/2026-11-12-bot-catalog-and-conversation-selection.md`（Bot 目录与会话）

## 提案

将所有内置 bot 统一迁移到 `apps/agent/src/bots/` 注册中心，各领域（conversation、coding、interview）降级为纯应用层编排，不再定义 bot。

### 新目录结构

```
apps/agent/src/
├── bots/                 # 统一 bot 注册中心
│   ├── registry.ts       # 工厂函数与依赖注入接口
│   ├── general/          # 通用对话 bot
│   │   ├── bot.ts        # BotDescriptor 工厂
│   │   ├── agent.ts      # AgentDefinition（从 conversation/agent.ts 移入）
│   │   └── profile.ts    # 提示词与策略（从 conversation/profiles 移入）
│   ├── coding/           # 编码 bot
│   │   ├── bot.ts        # BotDescriptor 工厂
│   │   ├── agent.ts      # AgentDefinition
│   │   └── policy.ts     # 提示词与策略
│   └── interview/        # 面试 bot（未来）
├── conversation/         # Conversation 应用层（保留）
│   ├── application.ts    # 会话编排循环
│   └── turn/             # 回合上下文
├── coding/               # Coding 应用层（保留）
│   ├── application.ts    # 编码用例
│   └── host.ts           # CLI host 装配
└── composition.ts        # 跨客户端组装（调整导出）
```

### 实施方式

统一注册表接口：

```typescript
// bots/registry.ts
export interface BotFactoryDeps {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
  skills?: SkillCatalog;
  instructions?: InstructionLoader;
}

export function createGeneralBot(deps: BotFactoryDeps): ConversationBot;
export function createCodingBot(deps: BotFactoryDeps): CodingBot;
```

每个 bot 目录结构：
- `bot.ts`：导出 `create<Name>Bot(deps)` 工厂函数
- `agent.ts`：导出 `<NAME>_AGENT_ID`、`<NAME>_IDENTITY`、`<NAME>_DISCOVERY` 和 `createAgentDefinition()`
- `profile.ts` / `policy.ts`：导出 system prompt、工具清单和其他策略配置

### 明确不做的事

- **不改变运行时语义**：bot 的身份、发现、工具授权、prompt 内容保持不变
- **不引入动态注册**：所有 bot 仍是编译期静态注册，不做运行时插件机制
- **不改变应用层接口**：`ConversationApplication`、`CodingHost` 等使用方不感知内部模块移动
- **不合并 bot 类型**：`ConversationBot` 与 `CodingBot` 的 Policy 类型仍然独立

## 模块边界

- `bots/`：只定义 bot 的身份、Agent 定义、prompt/policy 和工厂函数；不持有 store、不创建 run、不实现领域编排
- `conversation/`、`coding/`：只做领域应用编排（会话循环、run 协调、交接链）；不定义新 bot，从 `bots/registry` 获取
- `core/bot/`：保持不变，仍是 bot 契约、目录、可见性校验的基础设施
- `composition.ts`：改为从 `bots/registry` 导出工厂函数，不再深导入各领域

## 曾考虑的替代方案

- **保持现状，只重命名**：把 `conversation/profiles` 改名为 `bots/general/profile.ts`，但 bot 仍分散在各领域。舍弃理由：治标不治本，没有解决"领域既是应用层又是 bot 容器"的职责混乱。
- **动态插件机制**：设计运行时注册协议，允许外部注入 bot。舍弃理由：过度设计，当前所有 bot 都是内置的，且 AGENTS.md 明确"不接收 renderer 提供的任意 prompt 或工具实现"。
- **Bot 与 Agent 合并**：取消 `BotDescriptor` 层，直接在 `core/bot` 注册 `AgentDefinition`。舍弃理由：Bot 承载领域策略（Policy/Profile），Agent 只做模型执行，两者职责不同；合并会让 `core/` 污染领域概念。

## 验收标准

- 可观察结果：
  - desktop 创建新会话、bot 切换功能正常
  - CLI `answra code` 启动与交互正常
  - 所有 bot 的 `identity.name`、`discovery`、`tools` 配置与迁移前一致
- 自动化验证：
  - `pnpm verify` 全量通过（agent 576、UI 330、CLI 305、desktop 350 测试 + 架构检查）
  - `pnpm architecture:check` 通过：`bots/` 不依赖领域，领域不依赖 `bots/` 的子目录
- 需要的实机验证：
  - Windows/macOS desktop 手动测试会话创建、bot 展示、工具调用
  - CLI TUI 测试 `answra code` 启动、`/new`、消息发送

## 风险

- **大规模文件移动**：涉及 10+ 个文件的路径变更，导入调整容易遗漏。缓解：先保留旧路径的 re-export，分 3 个 phase 逐步迁移。
- **类型导入路径遗漏**：`ConversationAgentInput`、`CodingPolicy` 等类型可能在测试、composition 中有隐式依赖。缓解：每步完成后运行 `pnpm typecheck` 确认。
- **CLI 与 desktop 同时依赖**：两端可能对导出路径有不同依赖。缓解：Phase 1 保留 `@answra/agent` 根路径的原有导出，Phase 3 统一到 `@answra/agent/bots`。
