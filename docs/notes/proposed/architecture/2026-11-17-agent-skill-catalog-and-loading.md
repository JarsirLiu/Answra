# Note：Agent Skill 目录扫描与按需加载

状态：提案

## 问题

Agent 现有能力全部以 tool 形态提供：`Read`、`Grep`、`Edit`、`RunCommand`。tool 适合表达"能做什么"的原子操作，不适合表达"该怎么想、按什么流程做"的领域知识。改简历、会议纪要这类需求的主体是方法论（STAR 结构、JD 对齐、量化成果、行业惯例），用 tool 实现会把大量文字塞进 `inputSchema`/`description`，且每个常驻 tool 都要占上下文。

`docs/notes/implemented/feature/2026-11-13-cli-slash-command-palette.md` 第 104 行明确记录"不提供模型可调用的 Skill tool，也不让 Agent 自动推荐命令"。本提案推翻该结论，理由见"曾考虑的替代方案"。

同时存在一个语义冲突：仓库内 `.agents/skills/answra-{change,code,vision}/SKILL.md` 已经是 skill 形态（frontmatter + 正文），但它们服务的是"改这个仓库的人"，与终端用户场景不同。本提案需要在不打包开发者 skill 的前提下，让运行时扫描能自然索引到它们。

## 涉及范围

- 代码/模块：
  - 新增 `apps/agent/src/core/skill/`（`contracts.ts`、`catalog.ts`、`guidance.ts`）
  - 新增 `apps/agent/src/core/tool/builtin/skill/tool.ts`，注册进 `core/tool/builtin/index.ts`
  - `core/tool/contracts.ts`、`core/tool/registry.ts`：仅按需扩展注入参数，不改 `ToolEntry` 契约
  - `apps/agent/src/coding/policy.ts`、`apps/agent/src/conversation/profiles/registry.ts`：新增 `skills` 白名单字段
  - `apps/agent/src/coding/agent.ts`、`conversation/agent.ts`：`prepare()` 拼接 skill 索引
  - `apps/agent/src/host.ts`、`apps/agent/src/coding/host.ts`：宿主注入 `skillRoots`
  - 新增 `packages/skills/`：内置 skill 源（改简历等面向终端用户的能力）
  - `apps/desktop/src/main/conversation/workerTransport.ts`、`apps/cli/src/main.ts`、`apps/cli/src/remote/host/commandPort.ts`：三个宿主调用点分别填值
- UI/进程/协议/持久化表面：不改 `worker/protocol.ts`；不改 transcript 持久化格式；CLI/desktop UI 不改。skill 正文作为普通 tool 结果进入既有事件流。
- 相关 Note：
  - [CLI 斜杠命令面板](../../implemented/feature/2026-11-13-cli-slash-command-palette.md)（本提案推翻其中"不提供模型可调用 Skill tool"的结论）
  - [产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)（文档共创支柱、工具白名单红线）
  - [工具运行时可移植性与目录契约](../../proposed/architecture/2026-11-16-tool-runtime-portability-and-directory-contract.md)

## 提案

### 1. 核心形状：索引常驻，正文按需

沿用 Anthropic Agent Skills 的形态，但只借形态不借生态。每个 skill 是一个 Markdown 文件，带 YAML frontmatter：

```markdown
---
name: resume-rewrite
description: 改写或优化简历时使用。覆盖 STAR 结构、JD 对齐、量化成果与行业措辞。
---

# 正文...

## 写作流程
...
```

系统提示词只注入 `name` + `description` 索引；模型判断匹配后调用 `Skill` 工具取正文。正文一旦进入 transcript，由历史机制自然携带，不重复加载。

**明确不做：**
- 不做 skill 内脚本执行（skill 目录里的 `scripts/` 只是文本引用，执行仍需 `RunCommand`）
- 不做 URL 远程拉取（opencode 支持，我方无需求，且引入网络面与缓存失效问题）
- 不做文件监听热更新（见 §7）
- 不做 skill 暴露为斜杠命令（`slash` 字段留待后续，本提案不实现）

### 2. 三类来源与优先级

| 来源 | 路径 | 覆盖关系 |
|---|---|---|
| 内置 | `packages/skills/`（随包发布） | 基线 |
| 用户 | `~/.answra/skills/` | 覆盖同名内置 |
| 工作区 | 工作区根到项目根各层的 `.agents/skills/` | 覆盖同名用户与内置；近层覆盖远层 |

同名时高优先级覆盖低优先级，合并为 `Map<name, SkillInfo>`。顺序由 catalog 显式声明，不依赖文件系统遍历顺序。

**开发者 skill 不打包。** `.agents/skills/answra-{change,code,vision}` 属于工作区来源，只在用户实际打开本仓库时被索引到。这解决了"打包后普通用户看到代码规范"的污染问题，且不需要额外分类机制。

**内置 skill 的单一事实源是 `packages/skills/`。** 不在 `apps/desktop/resources/` 和 `apps/cli` 各存一份，避免双真相源漂移。两个宿主按 workspace 依赖解析该包目录。

### 3. 宿主注入，agent 不认物理路径

`agent` 是平台无关运行时库，不持有任何硬编码路径。新增契约：

```ts
/** skill 的三类来源根目录；缺省表示该来源不存在，不做任何兜底推断。 */
export interface SkillRoots {
  readonly builtin: string | null;
  readonly user: string | null;
  /** 工作区根（不是 `.agents/skills` 目录）；agent 从它向上到项目根逐层扫描。 */
  readonly workspaceRoot: string | null;
}
```

`AgentHostOptions` 与 `CodingHostOptions` 增加可选 `skillRoots`。三个宿主各自填值：

- `apps/desktop/src/main/conversation/workerTransport.ts`：解析 `packages/skills` 与 `~/.answra/skills`
- `apps/cli/src/main.ts`、`apps/cli/src/remote/host/commandPort.ts`：同上，各宿主自行解析

CLI 与 desktop 是并列宿主，不存在 CLI 依赖 desktop 资源的路径。

**不做静默降级：** 缺少 `skillRoots` 时"没有可用 skill"，`Skill` 工具不注册、索引为空；绝不回退到某个猜测目录。这与 `host.ts` 中 vad/recognizer "未注入即显式失败"的既有立场一致。注意此处与 `grepWorkerPath` 的 fallback 模式不同——grep 有进程内实现可回退，skill 没有。catalog 非空但查不到名字时列出可用名字；catalog 为空时列出内置、用户、工作区三类来源，避免把"扫错目录"误判成"没有 skill"。

### 4. `Skill` 工具按名字查表，不接受路径

```ts
ToolEntry<{ name: string }, SkillInfo>
```

- `id: toolId("skill.load")`，`name: "Skill"`
- `readOnly: true`、`destructive: false`、`concurrentSafe: true`、`sideEffectScope: "none"`
- `resultBudget: { strategy: "truncate", maxModelChars: SKILL_CONTENT_MAX_CHARS }`
- handler 在预构建的 `Map<name, SkillInfo>` 中查 key；未命中返回 `invalid-input` 失败码，列出可用名字

**安全红线：** 绝不 `path.join(skillRoot, name)`。查表天然免疫 `name = "../../.env"` 一类穿越。catalog 扫描侧另做软链接逃逸校验：对每个条目 `realpath` 后确认仍在扫描根之下，越界条目跳过并告警。

### 5. 索引渲染

按 profile 授权后渲染进 system prompt：

```xml
<available_skills>
  <skill>
    <name>resume-rewrite</name>
    <description>改写或优化简历时使用。...</description>
  </skill>
</available_skills>
```

用 XML 标签而非 Markdown 列表，边界清晰，模型不易把索引误读为正文。前置一句"任务与某 skill 描述匹配时用 Skill 工具加载"。

**token 预算（opencode 未做，本提案必须做，因为用户可自建 skill）：**
- 无 `description` 的 skill 不进索引（模型无从判断是否加载）
- 单个 description 超 `SKILL_DESCRIPTION_MAX_CHARS` 截断
- skill 总数超 `SKILL_INDEX_MAX_ENTRIES` 按 name 排序取前 N，并在索引中显式告知模型"列表已截断"

按 profile 白名单过滤，**不给通配符**：

```ts
interface ChatProfile { /* 既有字段 */ skills?: readonly string[] }
interface CodingPolicy { /* 既有字段 */ skills?: readonly string[] }
```

这与既有 `tools: readonly ToolId[]` 同构，也符合红线"不做 renderer 可注入的灵活性"：白名单在代码里静态声明，renderer 永远不能注入 skill 名单或正文。

### 6. 工具输出形态

```
<skill_content name="resume-rewrite">
# resume-rewrite
{正文}
Base directory for this skill: {目录}
<skill_files>
  <file>templates/resume.docx</file>
</skill_files>
</skill_content>
```

返回 base directory + 同目录文件相对路径清单（上限 `SKILL_FILE_LIST_MAX_ENTRIES`），让模型知道 `templates/`、`reference/` 存在，可再用 `Read` 深入。**只返路径不返内容。**

### 7. 扫描时机

每个会话首次 `prepare()` 扫描一次并缓存到会话生命周期，不做文件监听、不做跨会话缓存失效逻辑。理由：skill 数量小、扫描是本地 IO；监听会引入与 context 重载策略的耦合（opencode 源码里对这点也留有未决注释）。

### 8. 实施后的调整（2026-11-24）

初版把工作区来源固定为 `<workspaceRoot>/.agents/skills`，而 `AGENTS.md` 会向上找到项目根，两套发现范围不一致：从子包目录启动时能看到仓库根 `AGENTS.md` 里的 skill 引用，却加载不到对应 skill。

现改为：宿主注入工作区根，agent 复用 `core/workspace/projectRoot.ts` 从工作区根向上到最近的 `.git` 逐层扫描 `.agents/skills`，近层覆盖远层；`SkillCatalog.roots()` 供空 catalog 诊断；源码运行通过 `@answra/skills` 依赖解析内置 skill。详细根因与验证见 [工作区 skill 在子目录启动时不可见](../../implemented/bug-fix/2026-11-24-skill-workspace-root-discovery.md)。

## 影响表面

- **上下文成本**：每个 skill 常驻约 `name` + `description` 的 token；正文仅在加载时进入 transcript。
- **安全面**：新增一个可读取磁盘文本的 read-only 工具；路径由查表约束，不接受模型传入路径。
- **用户可见**：`~/.answra/skills/` 与工作区根到项目根各层的 `.agents/skills/` 成为用户可自助扩展 AI 能力的入口。用户新增 skill 后新会话生效。
- **打包面**：新增 `packages/skills` 作为 workspace 包；`apps/cli` 与 `apps/desktop` 各增加一条 workspace 依赖，不新增二进制资源。
- **无协议变化**：`worker/protocol.ts` 不改；skill 加载走既有 tool call 事件流。

## 模块边界

依赖方向保持 `domains → core`，新增内容全部落在 `core` 与宿主接线层，不新增领域、不让 core 反向依赖任何领域。

```text
apps/agent/src/core/workspace/
  projectRoot.ts 项目根发现（最近的 .git），AGENTS.md 与 skill 共用

apps/agent/src/core/skill/
  contracts.ts   SkillInfo、SkillRoots、索引与预算常量（唯一类型来源）
  catalog.ts     扫描三类来源 → 校验 → 合并覆盖 → Map<name, SkillInfo>
  guidance.ts    renderSkillIndex(skills) → <available_skills> 文本

apps/agent/src/core/tool/builtin/skill/tool.ts
                 Skill 工具：查表返回正文，readOnly，无路径入参
```

**各层职责与禁止携带：**

| 位置 | 只放 | 禁止 |
|---|---|---|
| `core/skill/contracts.ts` | skill 的类型与常量 | 文件系统调用、产品策略 |
| `core/workspace/projectRoot.ts` | 项目根发现（最近的 `.git`） | 拼接具体文件、产品策略 |
| `core/skill/catalog.ts` | 扫描、frontmatter 解析、路径安全校验、覆盖合并 | 提示词文案、profile 知识 |
| `core/skill/guidance.ts` | 索引渲染 | 读文件、扫描目录 |
| `core/tool/builtin/skill/tool.ts` | 查表与输出格式化 | 扫描目录（由 catalog 承担） |
| 各宿主组合根 | 解析路径并注入 `skillRoots` | skill 内容判断、索引裁剪 |

**归属判断：**

- `core/skill` 放 `core` 而非某个领域，因为它是通用机制而非产品策略：提示词、白名单全部留在 `coding/`、`conversation/` 的 policy/profile 里，`core` 不知道"改简历"是什么。
- **不预留第二消费者抽象。** 当前只有 `coding` 与 `conversation` 两个 profile 消费；若后续 `document` 领域出现不同加载语义，届时再抽端口，本提案不预建。
- `packages/skills` 是纯内容包（无 TS 逻辑、无运行时依赖），只被宿主用于解析路径，agent 不 import 它。这保证 agent 仍平台无关。
- catalog 只用 `node:fs` 与 `node:path`，不碰 Electron、不做网络。其可移植性与 `core/tool/builtin/read` 同级。

## 曾考虑的替代方案

- **每个能力都做成 tool（含改简历）：** 舍弃。方法论类知识塞进 `inputSchema`/`description` 会持续占用每个请求的上下文，且无法表达"多步骤流程 + 参考资料"。tool 应留给原子操作。

- **沿用 `2026-11-13-cli-slash-command-palette` 的"不提供 Skill tool"结论：** 舍弃。该结论成立的前提是"只有 14 个静态命令、无领域知识沉淀需求"。改简历等文档共创场景改变了前提：能力主体是方法论而非操作。推翻理由记录于本条，原 Note 保持归档不改写。

- **skill 放 `apps/desktop/resources/skills/`，CLI 打包时复制一份：** 舍弃。两份文件必然漂移，构成双真相源。`packages/skills` 单一源 + 各宿主解析，符合 `answra-code` §6 的单 writer 纪律。

- **内联进 agent bundle（opencode 的 EmbeddedSource 做法）：** 舍弃。skill 的高价值之一是用户可读可改；内联后用户无法调整措辞，也无法覆盖。

- **把 `.agents/skills/answra-*` 一起打包发给终端用户：** 舍弃。它们服务的是改本仓库的人；打包会让普通用户问"帮我改简历"时被索引到 TypeScript 规范。放到工作区来源即可自然覆盖，无需额外分类。

- **照搬 opencode 的 Effect + 插件化 Source 体系（directory/url/embedded）：** 舍弃。我方无 Effect 依赖，也无 URL 拉取需求；只保留其"来源列表 + 同名覆盖 + 索引渲染 + 查表加载"的设计形态，用现有 `ToolEntry` 契约重写。

- **`Skill` 工具接受文件路径：** 舍弃。模型给出的路径无法约束在 skill 根内，`../` 即可读到任意文件。按名字查表是唯一安全形态。

- **不做索引 token 上限：** 舍弃。opencode 未做是因为其 skill 主要来自受控来源；我方允许用户自建，几十个 skill 会把 system prompt 撑爆。

## 验收标准

- 可观察结果：
  - 新会话的 system prompt 中出现 `<available_skills>` 索引，只含被 profile 白名单允许且带 `description` 的 skill
  - 模型调用 `Skill` 后，正文与 base directory、文件清单进入 transcript
  - `~/.answra/skills/` 新增 skill 后，新会话可加载
  - 同名 skill 按 工作区 > 用户 > 内置 顺序生效
- 自动化验证：
  - frontmatter 解析：有/无 `name`、有/无 `description`、非法 YAML
  - 同名覆盖顺序
  - `name` 含 `../`、绝对路径、`\0` 时查表失败而非读文件
  - 软链接指向扫描根之外的条目被跳过
  - 正文超长被 `resultBudget` 截断且提示模型
  - description 超长被截断、总数超限时索引告知已截断
  - profile 白名单外的 skill 不出现在索引、直接调用返回失败码
  - 未注入 `skillRoots` 时不注册 `Skill` 工具且索引为空（不猜目录）
- 需要的实机验证：
  - CLI 与 desktop 两个宿主分别确认能索引到 `packages/skills` 与 `~/.answra/skills`
  - 在本仓库根或任意子目录运行时，模型能加载 `answra-code` 并按其自查（工作区来源向上到最近的 `.git`）
  - 打包后的安装包中 `packages/skills` 可正常解析
  - 源码运行（tsx）时内置 skill 通过 `@answra/skills` 工作区依赖可解析

## 风险

- **用户自建 skill 的信任边界。** skill 正文是模型会当作指令执行的文本，等价于用户级 prompt 注入。这不是新增的攻击面（用户本就能写 `AGENTS.md`、本就能用 `Edit` 改文件），但需在文档中说明：skill 与 `AGENTS.md` 同属本地可信内容，来源是本地磁盘而非网络或 renderer。
- **`description` 质量决定命中率。** 描述写得含糊会导致模型不加载或误加载。首版由我们编写内置 skill 时把关；用户自建的质量不在保证范围内。
- **索引截断后的能力可见性下降。** skill 数量超限时，排在后面的对模型不可见。上限取值需要在真实 skill 数量增长后校准。
- **跨会话缓存失效。** 用户在同一会话内新增 skill 不会立即生效，需新会话。这是有意接受的代价，换取实现简单和状态可预测。
- **`packages/skills` 的发布形态。** 该包需在构建时被打进 CLI 与 desktop 产物；若打包脚本漏配，宿主解析失败会表现为"没有可用 skill"。需要在验收中覆盖打包产物验证。
