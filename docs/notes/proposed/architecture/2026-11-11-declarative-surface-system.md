# Note：声明式浮窗系统

状态：提案

P0（产品预设 + 独立窗口 + 固定原语）已按 [实现 Note](../../implemented/architecture/2026-11-11-declarative-surface-p0.md) 落地；窗口池、Agent 接入、预设持久化和槽位覆盖仍为提案。

## 问题

当前所有用户可见内容都挂在固定面板上：对话、面试演练、笔记、工作区、设置。新增一种“引导卡”“确认框”“临时说明”时，必须同时新增组件、面板状态、IPC 频道和原生窗口，成本高且容易各自重复实现。

这套结构无法支持两类真实需求：

- 产品需要在任意时机弹出一个可点击、可拖动、可独立关闭的说明或确认窗口，而不是把内容塞进某个面板；面板共享悬浮条的几何和生命周期，关闭面板就会连带丢失内容。
- Agent 需要在对话过程中主动向用户确认信息、让用户选择或展示一段结构化结果。当前 Agent 只能输出文本，无法创建可交互表面，用户只能靠打字回应。

同时必须保持现有约束：会议隐身时窗口不进入系统捕获、不抢焦点、不进入任务栏；窗口可拖动；多显示器位置可恢复；Agent 不能获得任意 UI 或代码执行能力。

因此需要一套统一的声明式浮窗系统，让产品代码和 Agent 走同一份契约，并为未来“标准化覆盖产品形态”留出受控路径。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/surfaces/`：Spec、原语、动作、内置 preset、可覆盖槽位清单
  - `packages/shared/src/channels/surfaces.ts`、`packages/shared/src/bridge.ts`
  - `apps/desktop/src/main/surface/`：Broker、窗口宿主、持久化、IPC
  - `apps/desktop/src/main/windowSurfaceRegistry.ts`：新增原生窗口角色
  - `apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/main.tsx`
  - `packages/ui/src/surfaces/`：渲染器与固定原语
  - `apps/agent/src/core/surface/port.ts`、`apps/agent/src/core/tool/builtin/surface.ts`、`apps/agent/src/worker/protocol.ts`
- UI/进程/协议/持久化表面：
  - 新增独立原生窗口角色，沿用 `windowSurfaceRegistry` 的捕获保护、层级和非激活策略
  - 新增跨进程频道与 Bridge 方法
  - 持久化仅保存位置、预设、槽位覆盖和关闭记录，不保存卡片正文
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

首版原语只做：`stack`、`text`、`button`、`input`、`list`、`progress`、`divider`。渲染器不 eval、不使用 iframe、不加载远程内容，也不接受任意 HTML/CSS。

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

硬限制：节点不超过 64 个、嵌套不超过 6 层、动作不超过 6 个、Spec 不超过 64KB、文本不超过 2000 字符。动作只允许 `dismiss`、`submit`、`open-panel`、`send-message`、`invoke`；`invoke` 的命令由各领域注册并各自校验参数，Agent 不能新造命令。

### 3. 窗口运行时

新增原生窗口角色 `surface`，复用独立回复窗的既有模式：

- 窗口池上限默认 3；空窗复用，超出按优先级排队，优先淘汰 `ephemeral`
- `frame: false`、`transparent: true`、`skipTaskbar: true`、`movable: true`
- 只 `showInactive()`，不主动 `focus()`
- 显示前必须 `prepareWindowToShow()`，并在 `windowSurfaceRegistry` 登记
- 捕获保护沿用 `stealth-only`；隐身状态变化由 registry 统一应用
- 拖动通过标题区 `-webkit-app-region: drag`，交互控件 `no-drag`
- 位置：`ephemeral` 锚定悬浮条或指针；`pinned` / `preset` 写入用户目录并在多显示器变化时 clamp
- 尺寸由渲染器测量后上报，主进程只做 clamp 和落位
- 关闭只隐藏窗口，不销毁；应用退出时统一清理

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

Agent 工具只负责校验和调用端口；host 通过 worker 协议把请求发给 desktop；desktop 再校验一次后交给 Broker。首版采用非阻塞展示：用户点击后，desktop 发送一条结构化用户消息，Agent 继续对话。只有删除记忆、覆盖槽位等不可逆操作才引入阻塞确认。

### 5. 能力阶梯与产品形态

- L1 临时浮窗：Agent 用原语组合一次性卡片，不持久化，不需要额外确认。
- L2 保存预设：把卡片存成命名预设，保存前展示预览。
- L3 覆盖产品槽位：只允许覆盖产品声明为 `overridable` 的槽位，必须预览、确认、写入版本并支持回滚。
- L4 写代码/插件：不开放。

产品在代码里声明槽位契约（哪些原语、哪些动作、哪些数据、内置回退 preset）。覆盖文件存于 `appData/Answra/surfaces/overrides/`，启动时校验；不合法、版本不兼容或动作越权时回退内置 preset 并提示，不阻塞启动。首版只允许覆盖内容型槽位，悬浮条、主面板、设置页等核心 chrome 不开放覆盖。

### 6. 明确不做

- 不允许 Agent 生成 HTML、React、CSS、iframe 或远程页面。
- 不允许 Agent 直接创建窗口、控制窗口位置或大小。
- 不允许无上限开窗。
- 不在首版替换 `FloatingLayerHost`：条内瞬时通知和权限提示仍留在原处。
- 不在首版开放核心 chrome 的槽位覆盖。
- 不把卡片正文写入持久化或审计日志，只记录元数据。

### 7. 分阶段落地

- P0：Spec v1 + 单个 `surface` 窗口 + 四个原语 + 一个产品创建的浮窗（面试空态）。不接 Agent，不做预设持久化。
- P1：窗口池、队列、淘汰、`ephemeral` / `pinned`、位置持久化、两到三个产品 preset。
- P2：Agent 非阻塞浮窗；工具、端口、worker 帧、动作回传、审计。
- P3：保存预设、槽位覆盖、预览/确认/回滚、启动校验与回退。
- P4：阻塞确认、表单与文件选择、更多原语、受限数据绑定。

## 影响表面

- 用户可见面：新增可拖动浮窗；现有面板和悬浮条行为不变。
- 原生窗口：新增 `surface` 角色，进入窗口注册表的捕获保护、层级和非激活策略。
- IPC 与 Bridge：新增浮窗频道和 Bridge 方法；preload 只转发，不放业务逻辑。
- 持久化：新增 `appData/Answra/surfaces/` 下的预设、覆盖、位置和关闭记录；不保存正文。
- Agent：新增浮窗端口与工具；Agent 仍然不能直接控制桌面窗口。
- 安全与审计：新增动作白名单、大小限制、覆盖审批和回滚；审计只记录元数据。

## 模块边界

- `packages/shared/src/surfaces/`：只放 schema、动作白名单、内置 preset 和槽位声明，不渲染、不持有运行时状态。
- `packages/ui/src/surfaces/`：只负责把合法 Spec 渲染成原语树并回传动作，不校验权限、不持久化、不推断业务状态。
- `apps/desktop/src/main/surface/`：唯一信任边界；负责校验、队列、窗口、位置、持久化和审计。
- `apps/agent/src/core/surface/`：只定义端口与工具参数，不接触 Electron，不直接创建窗口。
- `windowSurfaceRegistry.ts`：继续作为所有原生窗口策略的唯一登记点；新角色必须登记并走 `prepareWindowToShow`。
- `FloatingLayerHost`：保留为条内瞬时通知与权限提示，不与浮窗系统合并。

## 曾考虑的替代方案

- **把浮窗塞进现有面板或 `FloatingLayerHost`：** 舍弃。面板共享悬浮条的几何、生命周期和关闭语义，无法独立拖动或在面板关闭后存在；`FloatingLayerHost` 是为不可拖的瞬时通知设计，自动消失语义也不适合确认。
- **每张卡创建一个 `BrowserWindow`：** 舍弃。Agent 可以随时创建表面，窗口数量不可控，z-order、拖动位置和资源回收都会变成不可验证的状态；改为固定上限的窗口池。
- **让 Agent 生成 HTML/React/iframe：** 舍弃。会引入代码执行、CSP、样式漂移、可测试性和供应链风险；AI 的自由度应由原语组合提供，而不是代码。
- **只做硬编码组件，每个引导单独开发：** 舍弃。这正是当前问题；每新增一种确认都要新增窗口和协议，无法让 Agent 复用。
- **让 Agent 直接操作 `BrowserWindow` 或桌面 API：** 舍弃。违反进程边界和现有窗口策略；Agent 只能通过端口请求表面，由主进程执行。
- **首版就做阻塞式 Agent 确认：** 舍弃。需要新增 request/response 生命周期、超时和取消语义，先做非阻塞展示可以把协议风险降到最低。
- **用 WebView 或远程页面承载 AI UI：** 舍弃。远程内容不可审计、会破坏离线与隐私约束，也无法保证与产品视觉一致。

## 验收标准

- 可观察结果：
  - P0：产品代码能创建一个可拖动、可关闭、不抢焦点的浮窗；隐身开启时截图和录屏不可见；重启后位置保留；按钮点击能回传动作。
  - P1：窗口池达到上限时按优先级排队；`ephemeral` 可被淘汰，`pinned` 不被淘汰；多显示器位置正确 clamp。
  - P2：Agent 能创建临时浮窗；用户动作回到 Agent；非法 Spec 被主进程拒绝且不显示。
  - P3：槽位覆盖有预览、确认、版本和回滚；非法覆盖启动时回退内置 preset。
- 自动化验证：
  - shared：Spec 接受/拒绝、节点/深度/文本/动作上限、动作白名单。
  - ui：原语渲染、动作回传、无障碍角色、空 Spec 安全降级。
  - desktop：窗口池复用与淘汰、位置 clamp、`revision` 冲突、隐身策略应用、IPC sender 校验、覆盖文件损坏回退。
  - agent：工具参数校验、端口调用、非阻塞结果回传、旧 run 更新拒绝。
  - `pnpm --filter @answra/shared test`、`pnpm --filter @answra/ui test`、`pnpm --filter @answra/desktop test`、`pnpm --filter @answra/agent test`、`pnpm typecheck`、`pnpm architecture:check`。
- 需要的实机验证：
  - Windows 11 隐身开启时，非激活窗口能否点击按钮和拖动；不能则退化为手动拖拽 IPC，并在 Note 中记录取舍。
  - 多显示器、显示器移除、全屏会议窗口上的层级和位置。
  - 截图/录屏工具下捕获保护的实际表现；只能陈述 Electron 内容保护已启用，不能承诺所有工具不可见。

## 风险

- 非激活窗口在 Windows 上的点击与拖拽行为未验证，可能迫使我们引入手动拖拽或临时聚焦策略。
- 窗口池与捕获保护、always-on-top、全屏会议层级组合后可能出现 z-order 或焦点回归问题，需要实机覆盖。
- Agent 生成的界面可能误导用户；必须依赖原语白名单、长度限制、动作白名单和覆盖审批，不能只靠 prompt。
- 持久化的槽位覆盖可能在产品升级后失效或让界面“长歪”；必须有 schema 版本、启动校验、内置回退和一键恢复默认。
- 浮窗过多会造成打扰；依赖窗口上限、队列、冷却和关闭记录，不能无限弹出。
- 非激活模式下键盘可达性受限；首版只保证鼠标操作，键盘用户需要能通过面板或快捷键完成同一动作。
- worker 协议新增浮窗帧会带来兼容和回滚成本；首版应把协议变更与产品创建路径分开，确保 P0/P1 不依赖 Agent。
- 浮窗可能承载简历、JD 等个人信息；只持久化位置和元数据，不保存正文，审计不记录内容。
