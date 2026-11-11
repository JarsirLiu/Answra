# Note：声明式浮窗系统

状态：提案

P0（产品预设 + 独立窗口 + 固定原语）已按 [实现 Note](../../implemented/architecture/2026-11-11-declarative-surface-p0.md) 落地；窗口池、Agent 接入、预设持久化和槽位覆盖仍为提案。

首个产品切片明确为“AI 主动引导式信息收集”：Agent 不再靠连续提问收集简历、项目和文档信息，而是主动召唤页面，让用户填写、选择和确认。该切片需要先补交互式表面（可聚焦窗口、表单原语、提交值），再接入 Agent；P0 的被动展示窗口不能直接承担表单。

## 问题

当前所有用户可见内容都挂在固定面板上：对话、面试演练、笔记、工作区、设置。新增一种“引导卡”“确认框”“临时说明”时，必须同时新增组件、面板状态、IPC 频道和原生窗口，成本高且容易各自重复实现。

这套结构无法支持两类真实需求：

- 产品需要在任意时机弹出一个可点击、可拖动、可独立关闭的说明或确认窗口，而不是把内容塞进某个面板；面板共享悬浮条的几何和生命周期，关闭面板就会连带丢失内容。
- Agent 需要在对话过程中主动向用户确认信息、让用户选择或展示一段结构化结果。当前 Agent 只能输出文本，无法创建可交互表面，用户只能靠打字回应。

当前最典型的失败场景是结构化信息收集：简历、项目经历和文档提纲如果继续用聊天式追问，AI 只能一轮问一个点，用户看不到整体进度、字段、已填内容和下一步，修改与回看也只能翻聊天记录。用户真正需要的是“AI 主动打开一页，用户填/选/确认，AI 再推进下一步”；对话只作为记录、补充说明和兜底，而不是主要输入面。

因此首个场景不是“AI 再会聊一点”，而是让 Agent 拥有受控的页面呈现能力：页面承载结构化字段，提交后回到 Agent，Agent 负责业务判断、草稿和下一步，而不是让用户逐轮打字完成表单。

同时必须保持现有约束：会议隐身时窗口不进入系统捕获、不抢焦点、不进入任务栏；窗口可拖动；多显示器位置可恢复；Agent 不能获得任意 UI 或代码执行能力。

因此需要一套统一的声明式浮窗系统，让产品代码和 Agent 走同一份契约，并为未来“标准化覆盖产品形态”留出受控路径。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/surfaces/`：Spec、原语、动作、内置 preset、可覆盖槽位清单
  - `packages/shared/src/channels/surfaces.ts`、`packages/shared/src/bridge.ts`
  - `apps/desktop/src/main/surface/`：Broker、窗口宿主、持久化、IPC
  - `apps/desktop/src/main/windowSurfaceRegistry.ts`：新增原生窗口角色
  - `apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/main.tsx`
  - `packages/ui/src/surfaces/`：渲染器、固定原语与表单控件
  - `apps/agent/src/core/surface/port.ts`、`apps/agent/src/core/tool/builtin/surface.ts`、`apps/agent/src/worker/protocol.ts`
  - `apps/agent/src/conversation/profiles/registry.ts`：首个 `guided-intake` 静态 profile，复用 conversation 域，不先新建领域
- UI/进程/协议/持久化表面：
  - 新增独立原生窗口角色，沿用 `windowSurfaceRegistry` 的捕获保护、层级和非激活策略
  - 新增交互式表面角色：可聚焦、可键盘输入，与会议隐身的被动表面分开
  - 新增跨进程频道与 Bridge 方法；提交动作携带字段值，但仍由主进程做形状与大小校验
  - 持久化仅保存位置、预设、槽位覆盖和关闭记录，不保存卡片正文；表单草稿归业务领域，不归浮窗系统
- 相关 Note：
  - [原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)
  - [悬浮表面视觉契约](../../implemented/architecture/2026-10-11-floating-surface-visual-contract.md)
  - [Agent host 组合与传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)
  - [面试演练与面试记忆](../../implemented/feature/2026-11-10-interview-rehearsal-and-memory.md)
  - [面试语音运行时模块边界](2026-10-19-interview-runtime-module-boundaries.md)
  - [面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)

## 提案

### 1. 三个对象

- `SurfaceSpec`：一份 JSON，描述窗口里有什么、能做什么。
- `SurfacePreset`：产品内置或用户保存的 Spec，可复用、可版本化。
- `SurfaceSlot`：产品声明的“这里允许被替换”的位置，只有被声明的槽位可被用户或 Agent 覆盖。

```text
产品代码 ─┐
          ├─→ SurfaceBroker（main，唯一入口）
Agent 工具 ┘        │  校验 / 队列 / 权限 / 持久化 / 审计
                    ↓
             SurfaceHost（窗口池，上限 N）
                    ↓  ?surface=...
             SurfaceWindowApp（UI，纯渲染）
                    ↓  用户点击
             SurfaceAction（白名单命令）→ 回到产品/Agent
```

### 2. SurfaceSpec 与固定原语

Spec 用 `zod` 定义并放在 `packages/shared`，主进程和 Agent 各校验一次；主进程是信任边界。

P0 已落地的是 `stack`、`text`、`button`、`list`、`progress`、`divider`。首个交互切片补 `input`、`select`、`checkbox` 和 `submit` 动作：

- `input`：`name`、`label`、`kind`（`text` / `textarea` / `url` / `number` / `date`）、`placeholder`、`required`、`maxLength`、`initialValue`。
- `select`：`name`、`label`、`options[{ value, label }]`、`required`、`initialValue`。
- `checkbox`：`name`、`label`、`initialValue`。
- `submit`：按钮引用 `actionId`，动作声明 `fields` 白名单；渲染器只回传已声明字段，不接受整段任意 JSON。

字段值只允许字符串和布尔值；单个值不超过 4000 字符、整次提交不超过 32KB、每张表单不超过 16 个字段。渲染器不 eval、不使用 iframe、不加载远程内容，也不接受任意 HTML/CSS；文件选择、富文本和任意组件不进入首个切片。

```ts
const surfaceSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64),
  revision: z.number().int().nonnegative(),
  producer: z.enum(["product", "agent", "user"]),
  title: z.string().max(80).optional(),
  root: surfaceNodeSchema,
  window: z.strictObject({
    width: z.number().int().min(220).max(560).optional(),
    draggable: z.boolean().default(true),
    dismissible: z.boolean().default(true),
    interaction: z.enum(["passive", "interactive"]).default("passive"),
    modality: z.enum(["none", "confirm"]).default("none"),
    anchor: z.enum(["bar", "pointer", "center"]).default("bar"),
  }).optional(),
  lifecycle: z.strictObject({
    kind: z.enum(["ephemeral", "pinned", "preset"]),
    ttlMs: z.number().int().min(0).max(600_000).optional(),
  }),
  actions: z.record(z.string(), surfaceActionSchema).default({}),
});
```

硬限制：节点不超过 64 个、嵌套不超过 6 层、动作不超过 6 个、Spec 不超过 64KB、文本不超过 2000 字符。动作只允许 `dismiss`、`submit`、`open-panel`、`send-message`、`invoke`；`invoke` 的命令由各领域注册并各自校验参数，Agent 不能新造命令。`submit` 的值还会在主进程和业务领域各校验一次，未知字段直接丢弃，不进入 Agent。

### 3. 窗口运行时

新增原生窗口角色 `surface`，复用独立回复窗的既有模式：

- 窗口池上限默认 3；空窗复用，超出按优先级排队，优先淘汰 `ephemeral`
- `frame: false`、`transparent: true`、`skipTaskbar: true`、`movable: true`
- 展示型表面只 `showInactive()`，不主动 `focus()`；交互式引导表面使用 `surface-interactive` 角色，允许聚焦和键盘输入
- 显示前必须 `prepareWindowToShow()`，并在 `windowSurfaceRegistry` 登记
- 展示型表面沿用 `stealth-only` 捕获保护；交互式表面与会议隐身互斥，隐身开启时拒绝打开并提示先退出隐身，避免抢焦点和让用户误以为会议中操作仍不可见
- 拖动通过标题区 `-webkit-app-region: drag`，交互控件 `no-drag`
- 位置：`ephemeral` 锚定悬浮条或指针；`pinned` / `preset` 写入用户目录并在多显示器变化时 clamp
- 尺寸由渲染器测量后上报，主进程只做 clamp 和落位
- 关闭只隐藏窗口，不销毁；应用退出时统一清理
- 交互式引导表面使用 `pinned`，不按 TTL 自动消失；关闭后由业务领域保留草稿，用户可重新召唤并继续

`SurfaceBroker` 负责去重、`revision` 冲突、队列、权限、持久化和审计。旧 run 的迟到更新必须被 `revision` 拒绝，不能覆盖新窗口。

### 4. 两个生产者

产品代码通过 `showPreset(presetId, data)` 使用内置或已保存的 preset；点击、空态、错误提示都走这一条。

Agent 通过注入的端口使用同一套能力：

```ts
interface SurfacePort {
  present(spec: SurfaceSpec): Promise<{ surfaceId: string }>;
  update(surfaceId: string, spec: SurfaceSpec): Promise<void>;
  dismiss(surfaceId: string): Promise<void>;
}
```

Agent 工具只负责校验和调用端口；host 通过 worker 协议把请求发给 desktop；desktop 再校验一次后交给 Broker。

展示型表面仍采用非阻塞动作：用户点击后，desktop 发送一条结构化消息，Agent 继续运行。交互式表单是异步等待用户操作，不阻塞整个应用；只有删除记忆、覆盖槽位等不可逆操作才引入阻塞确认。

提交动作不走 `send-message`：`submit` 回传 `surfaceId`、`actionId`、`revision` 和字段值，desktop 只校验形状、大小和白名单字段，不解释业务含义；Agent/领域应用负责校验业务规则、保存草稿并决定下一步。保存失败时返回字段级错误，浮窗保持打开，不自动 dismiss。

表单值与卡片正文都不进入 `SurfaceBroker` 的持久化或审计：未提交时由渲染层临时持有，提交后归业务领域草稿（工作区文件、记忆或领域 store）。浮窗只负责当前步骤的投影，重新打开时从领域草稿重建。

### 5. 能力阶梯与产品形态

- L1 临时浮窗：Agent 用原语组合一次性卡片，不持久化，不需要额外确认。
- L1.5 交互式引导浮窗：Agent 用固定原语组合表单，接收 `submit` 字段值，按步骤更新同一表面；业务草稿归领域，表面可固定、可重新打开。
- L2 保存预设：把卡片存成命名预设，保存前展示预览。
- L3 覆盖产品槽位：只允许覆盖产品声明为 `overridable` 的槽位，必须预览、确认、写入版本并支持回滚。
- L4 写代码/插件：不开放。

产品在代码里声明槽位契约（哪些原语、哪些动作、哪些数据、内置回退 preset）。覆盖文件存于 `appData/Answra/surfaces/overrides/`，启动时校验；不合法、版本不兼容或动作越权时回退内置 preset 并提示，不阻塞启动。首版只允许覆盖内容型槽位，悬浮条、主面板、设置页等核心 chrome 不开放覆盖。

### 6. 首个产品切片：AI 主动引导式信息收集

首个切片不追求“所有 UI 可编辑”，而是验证一条闭环：Agent 主动召唤页面，让用户填写、选择和确认，AI 根据提交结果推进下一步。对话保留为记录、补充说明和兜底，不再承担逐字段追问。

适用流程：

- 简历与项目收集：基本信息、教育、工作经历、项目、技能；已有简历、面试记忆或工作区资料可预填，缺失字段由页面补齐。
- 文档共创：目标、受众、篇幅、语气、提纲；逐节生成后提供“采用 / 重写 / 补充”，完成后写入工作区。
- 后续会议材料、申请表单等结构化流程复用同一模式，不为每个流程单独开发窗口。

首个端到端流程建议先做“简历/项目收集”，因为字段明确、可直接验证提交与草稿闭环；文档提纲和写作紧随其后，不同时铺开三条独立流程。

#### 交互流程

1. 用户表达意图或点击入口，例如“帮我整理简历”“写一份项目介绍”。
2. Agent 先读取用户已授权的工作区、面试记忆或已保存草稿；能预填的字段预填，缺少的事实不编造。
3. 信息不足时，Agent 调用 `surface.present` 打开一张引导页，而不是在聊天里连续发问。页面包含步骤标题、进度、字段、主提交按钮和“稍后继续”；“稍后继续”同样通过 `submit` 回传当前字段，由领域保存草稿。
4. 用户填写并提交；`submit` 把字段值、`surfaceId`、`actionId` 和 `revision` 回传。
5. Agent/领域应用校验并保存草稿；成功则调用 `surface.update` 更新同一个表面的下一步，失败则返回字段错误并保持页面打开。
6. 完成后展示摘要和确认动作；确认后写入工作区或记忆，关闭表面。用户重新召唤时，从领域草稿恢复当前步骤。

页面以表单为主，不把每一步拆成新的聊天回合，也不为每一步创建新窗口。步骤推进使用同一 `surfaceId` 的 `revision`，旧结果必须被拒绝。

#### 状态归属

- 未提交的输入只存在于交互式表面渲染器；提交后字段值归业务领域草稿，领域草稿是唯一事实来源。
- `SurfaceBroker`/窗口宿主只保存位置、表面 id、revision 和动作元数据，不保存简历正文、项目内容或表单值。
- 对话 transcript 记录用户意图和结构化提交摘要，不复制整页字段；需要回看时重新打开表面。
- 预填值必须可编辑并标明来源；模型猜测不能写成既成事实。

#### 首个切片的 AI 侧接入

- 复用 conversation 域，新增静态 `guided-intake` profile 和受授权的 surface 工具；不先新建领域。文档写作出现独立状态机、文件产物和确认流程后，再评估提升为 `document` 域。
- surface 工具只允许 `present`、`update`、`dismiss`，使用固定原语；Agent 不能写 HTML/CSS、不能创建任意窗口、不能调用未注册命令。
- 首个切片只允许在普通模式打开交互式表面；会议隐身时提示先退出隐身，避免抢焦点和捕获保护语义混淆。
- 密码、API Key、支付和账号凭据不允许由 Agent 生成的表面收集；这些继续使用产品固定的设置页和主进程安全存储。

### 7. 明确不做

- 不允许 Agent 生成 HTML、React、CSS、iframe 或远程页面。
- 不允许 Agent 直接创建窗口、控制窗口位置或大小。
- 不允许无上限开窗。
- 不在首版替换 `FloatingLayerHost`：条内瞬时通知和权限提示仍留在原处。
- 不在首版开放核心 chrome 的槽位覆盖。
- 不把卡片正文、表单值或简历内容写入 surface 持久化或审计日志，只记录元数据；领域草稿按业务规则单独保存和删除。
- 不让 Agent 生成密钥、账号、支付或权限确认表单；这些始终由产品固定界面和主进程安全存储承载。
- 首个切片不做用户自定义槽位、任意主题、任意布局或“AI 重写全部 UI”；只做固定原语和产品声明的引导流程。

### 8. 分阶段落地

- P0（已落地）：Spec v1 + 单个 `surface` 窗口 + 固定展示原语 + 一个产品预设。不接 Agent，不做表单。
- P1：交互式表面基础：`surface-interactive` 可聚焦角色、`input/select/checkbox`、`submit` 字段值、字段级错误、`pinned` 生命周期；先用产品 preset 验证，不接 Agent。
- P2：首个产品切片：Agent surface 工具与端口、worker 帧、`guided-intake` profile、简历/项目收集端到端、领域草稿与重新打开、元数据审计。这是“AI 主动召唤页面”的第一条证明。
- P3：文档提纲/写作复用同一套引导；窗口池、队列、`ephemeral`/`pinned` 策略完整化、预设持久化。
- P4：槽位覆盖、预览/确认/回滚、更多原语、文件选择、阻塞确认和受限数据绑定。

## 影响表面

- 用户可见面：新增被动说明浮窗和交互式引导页；简历/项目/文档流程从连续问答改为页面填写，对话保留为记录和补充说明。
- 原生窗口：新增展示型 `surface` 与交互式 `surface-interactive` 策略，分别进入窗口注册表的捕获保护、层级和焦点策略。
- IPC 与 Bridge：新增浮窗频道和 Bridge 方法；`submit` 携带字段值，preload 只转发，不放业务逻辑。
- 持久化：新增 `appData/Answra/surfaces/` 下的预设、覆盖、位置和关闭记录；不保存正文。简历/项目/文档草稿由业务领域保存，并遵循各自的删除与恢复规则。
- Agent：新增浮窗端口、surface 工具和 `guided-intake` profile；Agent 仍然不能直接控制桌面窗口或创建新能力。
- 安全与审计：新增动作白名单、字段值大小限制、敏感字段禁入、覆盖审批和回滚；审计只记录 surface id、revision、actionId 和字段元数据。

## 模块边界

- `packages/shared/src/surfaces/`：只放 schema、动作白名单、字段定义、内置 preset 和槽位声明，不渲染、不持有表单值或运行时状态。
- `packages/ui/src/surfaces/`：只负责把合法 Spec 渲染成原语树、维护当前未提交输入、回传动作和字段值；不校验业务规则、不持久化、不推断下一步。
- `apps/desktop/src/main/surface/`：唯一信任边界；负责 schema/字段白名单/大小校验、队列、窗口、焦点策略、位置和元数据审计；不解释业务字段。
- `apps/agent/src/core/surface/`：只定义端口与工具参数，不接触 Electron，不直接创建窗口。
- `apps/agent/src/conversation/profiles/`：`guided-intake` profile 只声明提示与授权 surface/工作区工具；简历、项目和文档草稿由领域应用持有，不塞进 surface 系统。
- 未来 `apps/agent/src/document/`：当文档写作出现独立状态机、产物写入和确认流程时再建立；此前不为了表单提前建域。
- `windowSurfaceRegistry.ts`：继续作为所有原生窗口策略的唯一登记点；新角色必须登记并走 `prepareWindowToShow`。
- `FloatingLayerHost`：保留为条内瞬时通知与权限提示，不与浮窗系统合并。

## 曾考虑的替代方案

- **把浮窗塞进现有面板或 `FloatingLayerHost`：** 舍弃。面板共享悬浮条的几何、生命周期和关闭语义，无法独立拖动或在面板关闭后存在；`FloatingLayerHost` 是为不可拖的瞬时通知设计，自动消失语义也不适合确认。
- **每张卡创建一个 `BrowserWindow`：** 舍弃。Agent 可以随时创建表面，窗口数量不可控，z-order、拖动位置和资源回收都会变成不可验证的状态；改为固定上限的窗口池。
- **让 Agent 生成 HTML/React/iframe：** 舍弃。会引入代码执行、CSP、样式漂移、可测试性和供应链风险；AI 的自由度应由原语组合提供，而不是代码。
- **只做硬编码组件，每个引导单独开发：** 舍弃。这正是当前问题；每新增一种确认都要新增窗口和协议，无法让 Agent 复用。
- **让 Agent 直接操作 `BrowserWindow` 或桌面 API：** 舍弃。违反进程边界和现有窗口策略；Agent 只能通过端口请求表面，由主进程执行。
- **首版就做阻塞式 Agent 确认：** 舍弃。需要新增 request/response 生命周期、超时和取消语义，先做非阻塞展示可以把协议风险降到最低。
- **继续用聊天逐字段追问简历/项目：** 舍弃。用户看不到整体结构、进度和已填内容，修改与回看只能翻聊天记录；这正是首个切片要解决的体验问题。对话保留为补充说明，不做主输入面。
- **先硬编码一张简历表单：** 舍弃为首个方案。短期更快，但项目、文档提纲和后续材料要重复开发，且无法验证 Agent 主动组合页面的能力；只有在 surface 系统阻塞时作为临时原型，不进入正式架构。
- **把表单草稿放在 SurfaceBroker：** 舍弃。会把简历、项目等个人信息写进窗口状态和审计边界，也会让表面系统承担业务生命周期；草稿必须归领域应用。
- **让 AI 重写全部核心 UI：** 舍弃。悬浮条、设置页、权限确认、密钥和支付界面需要稳定与可审计；AI 只能生成内容型表面和产品声明的槽位。
- **用 WebView 或远程页面承载 AI UI：** 舍弃。远程内容不可审计、会破坏离线与隐私约束，也无法保证与产品视觉一致。

## 验收标准

- 可观察结果：
  - P0：产品代码能创建一个可拖动、可关闭、不抢焦点的展示浮窗；隐身开启时截图和录屏不可见；重启后位置保留；按钮点击能回传动作。
  - P1：交互式表面能聚焦输入、显示字段级错误、提交已声明字段并保持 `pinned`；关闭后不自动丢失业务草稿。
  - P2：Agent 能在简历/项目流程中主动打开引导页；用户提交后 Agent 更新同一表面进入下一步，不再要求用户逐轮打字；关闭后可重新召唤并从领域草稿继续。
  - P2：表单值、简历正文和项目内容不进入 surface 持久化或审计；未知字段、超长值和未授权动作被拒绝。
  - P3：文档提纲/写作复用同一引导机制；窗口池、暂停/恢复和预设持久化可用。
  - P4：槽位覆盖有预览、确认、版本和回滚；非法覆盖启动时回退内置 preset。
- 自动化验证：
  - shared：Spec 接受/拒绝、节点/深度/文本/动作上限、动作白名单、表单字段与 `submit` 值白名单、字段/提交大小上限。
  - ui：表单原语渲染、未提交本地状态、必填/长度错误、提交载荷、错误不关闭、重新打开回填、无障碍标签、空 Spec 安全降级。
  - desktop：`submit` sender/字段/大小校验、未知字段丢弃、`revision` 冲突、交互式焦点策略、隐身模式拒绝、位置 clamp。
  - agent：surface 工具参数校验、`guided-intake` profile 授权、`present/update` 端口、提交值回传、领域草稿保存/恢复、旧 revision 拒绝。
  - 首个切片至少有一条集成测试覆盖“Agent 打开页面 → 用户提交 → Agent 更新下一步 → 关闭重开恢复”。
  - `pnpm --filter @answra/shared test`、`pnpm --filter @answra/ui test`、`pnpm --filter @answra/desktop test`、`pnpm --filter @answra/agent test`、`pnpm typecheck`、`pnpm architecture:check`。
- 需要的实机验证：
  - Windows 11 下交互式表面能否正常聚焦、键盘输入、拖动和关闭；展示型非激活表面能否点击和拖动。
  - 交互式表面在会议隐身开启时是否被正确拒绝，不出现“界面可见但用户以为不可见”的状态。
  - 多显示器、显示器移除、全屏会议窗口上的层级和位置。
  - 简历/项目表单关闭重开后草稿是否完整；日志、审计和崩溃转储不得出现表单正文。
  - 截图/录屏工具下捕获保护的实际表现；只能陈述 Electron 内容保护已启用，不能承诺所有工具不可见。

## 风险

- 非激活窗口在 Windows 上的点击与拖拽行为未验证，可能迫使我们引入手动拖拽或临时聚焦策略。
- 窗口池与捕获保护、always-on-top、全屏会议层级组合后可能出现 z-order 或焦点回归问题，需要实机覆盖。
- Agent 生成的界面可能误导用户；必须依赖原语白名单、长度限制、动作白名单和覆盖审批，不能只靠 prompt。
- 持久化的槽位覆盖可能在产品升级后失效或让界面“长歪”；必须有 schema 版本、启动校验、内置回退和一键恢复默认。
- 浮窗过多会造成打扰；依赖窗口上限、队列、冷却和关闭记录，不能无限弹出。
- 交互式表面与被动展示表面的焦点策略混用会导致引导页抢焦点、会议浮窗被误聚焦；必须分成两个窗口角色并分别验证。
- 非激活模式下键盘可达性受限；展示型只保证鼠标操作，交互式表单必须允许键盘完成，否则无法承担简历/项目收集。
- 表单编辑期间如果 Agent 通过 `update` 覆盖同一表面，会丢失用户输入；首版提交前不主动更新字段，`revision` 冲突时保留用户本地输入并要求确认。
- 用户关闭页面或应用崩溃会丢失未提交字段；首个切片按步骤提交并保存领域草稿，关闭前提示未提交内容，不承诺逐键持久化。
- AI 预填可能把猜测写成事实；预填必须可编辑、标明来源，并在写入文件或记忆前让用户确认。
- 表单过长会让新的引导体验退化成更差的问卷；限制步骤、字段数和每页信息量，允许“稍后继续”，不要一次收集全部内容。
- 交互式表面虽然不阻塞应用，但 Agent 流程会等待用户提交；必须有取消/关闭路径，不能留下永远等待的 run。
- worker 协议新增浮窗帧会带来兼容和回滚成本；首版应把协议变更与产品创建路径分开，确保 P0/P1 不依赖 Agent。
- 浮窗可能承载简历、JD 等个人信息；surface 只持久化位置和元数据，领域草稿的保存位置、保留期和删除入口必须明确，审计和日志不记录正文。
