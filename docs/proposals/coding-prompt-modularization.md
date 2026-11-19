# Answra Coding Bot 提示词模块化提案

## 目标

将现有的单文件系统提示词拆分为模块化结构，职责分离，便于维护和扩展。

---

## 模块划分方案

### 1. 核心系统提示词 (`policy.ts`)

**职责：** 定义身份、核心行为原则、沟通风格

**内容：**

```typescript
const CODING_SYSTEM_PROMPT = [
  "你是 Answra 的命令行编码助手。",
  "",
  "# 核心原则",
  "基于实际文件内容工作，不要根据文件名、印象或描述猜测。",
  "一轮对话内完成任务；遇到阻塞主动尝试解决，而不是停在分析阶段。",
  "修改后验证结果（测试、类型检查、编译），失败就继续修复。",
  "",
  "# 代码修改策略",
  "新项目：可大胆创新，展示创造力。",
  "现有代码：外科手术式修改，尊重周边代码，不过度重构。",
  "",
  "# 沟通风格",
  "简洁、直接、友好。保持用户知情但不过度解释。",
  "长任务定期汇报进度（8-12 字概括已完成+下一步）。",
  "",
  "最终回复根据任务复杂度调整：",
  "- 小改动（≤10 行）：2-5 句话，无标题",
  "- 中等改动：≤6 条要点",
  "- 大型改动：按文件归纳，1-2 条要点/文件",
  "不复述代码内容。",
  "",
  "# AGENTS.md 规范",
  "工作区的 AGENTS.md 包含代码约定和开发指南。",
  "作用域：包含它的目录树。嵌套的优先级更高。用户指令优先级最高。",
  "修改任何文件前，检查适用的 AGENTS.md 并遵守。",
].join("\n");
```

**保留在这里的理由：** 核心身份、行为哲学、沟通契约。

---

### 2. 工具使用指南

**位置：** 各工具的 `description` 字段（推荐）

**现状：**
- Read/Edit/Grep 工具的 description 已包含使用规范
- 例如 Read 说明"Do not re-read a file you just edited"
- 例如 Edit 说明"Read the file before editing when you need to confirm the exact text"

**行动：**

补充 RunCommand 工具的 description，添加：
- 并行调用建议："Independent reads/searches can be parallelized"
- Windows 语法提示（已有环境上下文，无需重复）

**不创建独立文件的理由：** 工具规则跟着工具定义走，职责分离清晰。

---

### 3. 验证与测试策略

**位置：** `apps/agent/src/coding/validationPolicy.ts`

```typescript
export const VALIDATION_POLICY = [
  "# 验证策略",
  "从具体到广泛：单元测试 → 集成测试 → 类型检查 → lint。",
  "",
  "运行时机：完成代码修改后自动运行相关测试。",
  "失败时最多迭代 3 次修复。",
  "3 次后仍失败，说明阻塞原因并交给用户。",
  "",
  "测试添加：有测试框架的项目可添加缺失测试；无测试的项目不引入框架。",
  "格式化：有 formatter 配置时运行；最多重试 3 次；无 formatter 不添加。",
  "",
  "不修复无关的失败测试。可在最终消息提及。",
].join("\n");
```

**使用方式：** 检测到测试框架（package.json scripts、pytest 配置等）时动态注入。

---

### 4. 安全边界指南

**位置：** `apps/agent/src/coding/safetyPolicy.ts`

```typescript
export const SAFETY_POLICY = [
  "# 操作风险分级",
  "低风险（直接执行）：读文件、搜索、单文件编辑。",
  "中风险（执行并提及）：安装依赖、修改配置、运行构建。",
  "高风险（询问确认）：删除多个文件、生产变更、数据库操作。",
  "",
  "# Git 操作",
  "不自动 commit，除非用户明确要求。",
  "推送到新分支，不直接推 main/master。",
  "不使用 --force 和 --amend，除非用户明确要求。",
  "",
  "# 敏感文件",
  "不直接回显 .env、私钥、token 的内容。引用时用键名而非值。",
].join("\n");
```

**使用方式：** 作为独立 context block，在涉及高风险操作时注入。

---

### 5. 环境上下文

**位置：** `apps/agent/src/coding/context.ts` 的 `buildCodingEnvironmentContext()`

**保持现状：** 已在正确位置，运行时动态生成。

---

## 最终系统提示词组装

**在 `agent.ts` 的 `prepare()` 方法中：**

```typescript
const system = [
  input.policy.systemPrompt,                         // 核心身份和原则
  buildCodingEnvironmentContext(),                   // 运行环境（动态）
  buildCodingWorkspaceContext(input.workspaceRoot),  // 工作区路径
  ...(skillIndex ? [skillIndex] : []),               // Skill 索引
  // 按需动态注入
  ...(hasTestFramework(input.workspaceRoot) ? [VALIDATION_POLICY] : []),
  ...(requiresSafety ? [SAFETY_POLICY] : []),
].join("\n\n");
```

---

## 实施步骤

### Phase 1: 精简核心提示词

- 移除工具使用细节（已在工具 description）
- 补充沟通风格和输出格式分级规则
- 添加 AGENTS.md 优先级规则

### Phase 2: 增强工具 description

- Read/Edit/Grep：已完善
- RunCommand：补充并行调用建议

### Phase 3: 创建独立策略文件

- `validationPolicy.ts` - 测试验证策略
- `safetyPolicy.ts` - 安全边界指南

### Phase 4: 动态注入机制

- 检测工作区特征（package.json、pytest.ini、Cargo.toml）
- 按需加载策略模块

---

## 收益

| 指标 | 现状 | 改进后 |
|-----|------|-------|
| 提示词长度 | 6 行 | 核心 ~20 行 |
| 职责分离 | 工具规则混在系统提示词 | 工具规则在工具定义 |
| 可维护性 | 单文件难扩展 | 模块化易扩展 |
| 上下文效率 | 静态加载全部 | 按需动态注入 |
| 对标 Codex | 缺少关键指导 | 覆盖核心场景 |

---

## 需要决策的问题

### 1. 工具使用指南放哪？

- **方案 A**：独立 `toolGuidance.ts` 文件
- **方案 B**：增强各工具的 `description`（推荐）

**推荐理由：** 工具规则跟着工具定义走，职责分离更清晰。

### 2. 验证策略动态注入？

- **是** - 检测到测试框架才加载（推荐）
- **否** - 始终包含

**推荐理由：** 减少无测试项目的上下文消耗。

### 3. 安全策略优先级

- **高** - 创建独立文件立即实施
- **中** - 先完善核心提示词（推荐）
- **低** - 暂不实施

**推荐理由：** 先确保核心行为稳定，安全策略可渐进式添加。

### 4. 参考 Codex 的部分

可选参考内容：
- Planning 工具使用指导
- Progress updates 格式规范
- Final answer verbosity 分级规则（已包含）
- Preamble messages 规范

**建议：** 优先采纳 Final answer verbosity 分级和 Progress updates 格式。

---

## 附录：Codex 提示词对比分析

### Codex 的优势

1. **结构层次清晰** - 身份 → 工作方式 → 工具指南
2. **行为原则详细** - Autonomy、Ambition vs. precision、Responsiveness
3. **输出格式规范** - 根据任务复杂度调整详细程度
4. **验证策略明确** - 区分不同 approval mode 下的行为

### Answra 的特色

1. **简洁直接** - 6 行核心提示词，易于理解
2. **工具规则分离** - 已在工具 description 中实现职责隔离
3. **环境上下文动态** - 运行时生成，适配实际环境

### 待补充部分

- 沟通风格和输出格式分级（本提案已包含）
- AGENTS.md 优先级规则（本提案已包含）
- 进度汇报规范（本提案已包含）
- 验证策略独立模块（本提案已设计）
- 安全边界指南（本提案已设计）
