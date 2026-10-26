# Note：会议场景下的窗口焦点与输入体验

状态：提案

## 问题

在线会议等端普遍用页面内的前端信号判断“用户是否离开页面”，常见实现是：

- `document.addEventListener("visibilitychange")`，读 `document.visibilityState`；
- `window` 的 `blur` / `focus` / `pagehide` / `pageshow`；
- 定时轮询 `document.hasFocus()`；
- 少数实现还会叠加 `fullscreenchange`、鼠标离开、剪贴板与窗口尺寸变化。

Answra 当前的浮窗是**普通可聚焦窗口**：创建时未指定 `focusable`，`SURFACE_POLICIES.main.nonActivating` 为 `false`（`apps/desktop/src/main/windowSurfaceRegistry.ts`）。首次显示已改为 `showInactive()`（`apps/desktop/src/main/mainWindowController.ts`），但窗口仍可在用户点击时激活。现有输入由聚焦编辑器的 DOM `keydown` 进入 `useEmbeddedIme.sendKey` → IPC → Rime；非激活窗口收不到这条 DOM 键盘事件路径。

由此产生三类暴露：

1. **启动即失焦。** `show()` 会夺取前台焦点，用户即使不操作，也会让下层浏览器 `blur` 一次。该行为与输入无关，属于可独立修复的缺陷。
2. **每次“切回浮窗”失焦一次。** 截图、发送、再次截图这些操作本身不依赖焦点（`captureIpc.ts:87` 隐藏、`selectionWindow.ts:55` 与 `captureIpc.ts:168` 均用 `showInactive()`，发送是纯 IPC），但用户必须点击浮窗上的按钮或输入框；点击一个可聚焦窗口就会把前台从浏览器切走。一轮操作只计一次，多次点击浏览器再点回来会再计。
3. **与焦点无关的页面状态变化。** 主窗口浮窗放大到盖住整个浏览器时，Chrome 在 Windows 上的原生遮挡检测（native window occlusion）可能把页面判为 hidden，从而触发 `visibilitychange`。任务栏显示和第二实例唤起也会影响用户看到的窗口行为，但不属于键盘输入焦点问题，应作为独立窗口体验决定处理。

需要强调的口径：`visibilitychange` 与小尺寸置顶窗口没有必然关系。一个 340×60 的浮窗抢焦点只会让页面 `blur`，页面通常仍是 `visible`。因此需要分别评估两类用户可观察的状态变化：**焦点变化**（由窗口激活与输入方式决定）和**页面可见性/遮挡变化**（受布局和尺寸影响）。不能把消除其中一种变化描述成整体不可见或不可发现。

本提案面向用户获准使用辅助工具的在线会议、商务沟通和演示场景，目标是减少 Answra 启动和非文本操作造成的意外焦点切换，同时保持正常、明确的文本输入体验。本提案不尝试隐藏应用身份、抑制或伪造第三方页面的焦点/可见性信号，也不把“第三方页面观察不到 Answra 操作”作为目标或承诺。窗口捕获保护由[综合隐身模式提案](2026-10-13-comprehensive-stealth-mode.md)单独定义；内容捕获保护与前台焦点是两类独立能力。

## 涉及范围

- 代码/模块：
  - `apps/desktop/src/main/mainWindowController.ts`（主窗口创建与首次显示）
  - `apps/desktop/src/main/ime/*`（现有会话、租约、候选窗行为）
  - `apps/desktop/test/fixtures/focus-probe.html`（仅供人工实测的静态探针，不进入产品构建）
- UI/进程/协议/持久化表面：主窗口首次显示行为和人工诊断方式；不改变任务栏行为、IME 会话/候选窗契约、对话协议、会话存储或截图产物语义。
- 相关 Note：
  - [会议场景隐身模式的窗口与捕获边界](2026-10-13-comprehensive-stealth-mode.md)
  - [原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)
  - [内置 Rime 输入法](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)
  - [统一 IME 输入目标生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)
  - [IME 候选窗锚点单一写入](../../implemented/architecture/2026-10-16-ime-candidate-anchor-single-writer.md)
  - [隐身模式内置中文键盘方案否决](../../rejected/architecture/2026-10-13-stealth-virtual-keyboard-evaluation.md)
  - [焦点探针](../../../../apps/desktop/test/fixtures/focus-probe.html)

## 提案

按“测量现状、消除无关的焦点夺取、验证 Rime 与编辑器能否解耦、评估平台差异”分阶段推进。现有 Rime 引擎接收结构化按键请求并调用 `RimeProcessKey`，理论上不要求按键一定来自 DOM，也不依赖 Windows/macOS 系统 CJK IME；但当前按键来源、目标 lease、编辑器 selection/caret 和候选锚点都与 DOM/native focus 绑定。能否让完整编辑体验在窗口不激活时工作，必须逐层验证。不得以改变或归零第三方页面信号为验收条件。

### 0. 先用可复现的探针定义暴露面

仓库内的[焦点探针](../../../../apps/desktop/test/fixtures/focus-probe.html)只用于手动验证，不进入产品构建。页面记录：

- `visibilitychange` 与 `visibilityState` 变化；
- `window` 的 `blur` / `focus`；
- 每 500ms 的 `document.hasFocus()` 采样；
- 页面报告当前计数到控制台，便于人工与自动化验证焦点体验。

探针用于区分焦点变化和页面可见性变化，并验证应用交互是否打断用户当前工作；它只用于测试，不进入产品构建。

### 1. P0（已实施）：移除与输入无关的焦点夺取

- 首次显示在 `createWindow().once("ready-to-show")` 中调用 `showInactive()`，替代 `created.show()`（`mainWindowController.ts`）。浮窗出现后不主动接管焦点；用户明确点击文本输入区时仍可正常激活并输入。策略预检失败时仍保持隐藏。
- 第二实例由用户显式启动，保留现有 `focus()` 唤起行为；它不是应用自动启动导致的无关焦点夺取，不纳入本次调整。
- 任务栏可见性不属于焦点问题，本提案不随隐身状态修改 `skipTaskbar`；如需调整任务栏行为，应单独说明产品预期和可发现性影响。
- 不改变任何键鼠输入代码。controller 单测覆盖首次显示走 `showInactive()` 和策略预检失败时保持隐藏；Windows/macOS 实机焦点轨迹仍待验证。探针记录 Answra 启动前后浏览器的真实事件；验收只要求 Answra 启动路径不主动激活自身窗口，不要求浏览器的所有事件计数为零。

### 2. P1（已具备观测工具）：把焦点事实纳入诊断

- 使用现有 `logImeDiagnostic` 窗口事件以及焦点探针确认真实焦点轨迹；主窗口已记录 show/hide/focus/blur/minimize/restore 和可见/聚焦状态。
- 诊断**不记录按键内容、坐标、截图、前台应用名称或对话内容**。
- 探针将 `blur`/`focus`、`visibilitychange`、`pagehide`/`pageshow` 事件和每 500ms 的 `document.hasFocus()` 采样分开呈现，可清零计数并复制有界事件报告。
- 工具已加入；Windows/macOS 的实际轨迹采集仍待在目标机器上执行。观测结果用于判断 Answra 自身窗口操作的影响，不把第三方页面信号降为零作为目标。

### 3. P2：验证内置 Rime 的非聚焦输入可行性；暂不进入生产实现

对照检查了 Natively 项目的 stealth typing 实现。它的核心不是让普通聚焦窗口“隐藏失焦”，而是按平台建立非激活窗口和独立键盘输入通道：Windows 使用 `setFocusable(false)` / `WS_EX_NOACTIVATE`，并通过 `WH_KEYBOARD_LL` 捕获按键后送入 renderer；macOS 将浮窗配置为非激活 `NSPanel`，同时使用 `CGEventTap` 获取输入。该项目还检测活动键盘布局；CJK IME 活跃时禁用 stealth typing 并退回普通聚焦输入，因为低级钩子拿到的按键不能替代 IMM32/TSF 或 macOS 输入法的组合与候选流程。macOS 路径还需要 Accessibility 授权。此参考说明独立输入通道在特定平台上可实现，但不是对现有 Rime 链路的直接修补，也不构成所有第三方页面信号都不可观察的保证。

关键修正：Natively 在 CJK IME 活跃时降级，是因为其低级键盘钩子试图把按键转换成字符，无法代替系统 IMM32/TSF/macOS 输入法；这不能直接推出 Answra 的内置 Rime 也不能输入中文。Answra 已有 librime、键值映射和 Rime 候选处理，潜在路线是把物理按键规范化为现有 `processKey` 契约，再由应用 adapter 更新文本和选区。当前未知点是非 DOM 按键来源、逻辑输入目标、窗口失焦时 lease 的定义，以及 Chromium 编辑器 selection/caret 和候选定位在失去原生焦点后的行为。

本阶段按以下门槛做隔离原型，不改变生产输入行为，也不将“第三方页面没有记录事件”作为成功条件：

- **P2-A（已验证，范围有限）：验证 Rime 引擎与 DOM 按键来源可分离。** 在 Windows 11 专业版 build 26200 上，直接驱动仓库内 protocol v2 的 `answra-rime-host.exe` 与 librime 1.17.0，使用临时 user data，不经过 Electron、DOM、`ImeSessionManager` lease 或系统键盘钩子。启用后发送 `n/i/h/a/o` 的 keydown/key-up 序列，preedit 到达 `ni hao`，候选包含“你好”，空格提交得到 `committedText="你好"`；`rimeKeyMapping.test.ts` 3 项通过。这证明现有 helper/librime 可以处理脱离 DOM 事件的结构化按键并完成中文组合，不证明 `RimeBridge` IPC、非聚焦 editor adapter、物理键盘采集或原生窗口焦点行为已经可用。下一步验证 P2-B；仍需覆盖退格、方向键、候选翻页/选择等完整编辑命令。
- **P2-B：验证逻辑输入目标与 DOM focus 可分离。** 使用隔离的 textarea 和 CodeMirror harness，显式登记目标并保留 selection snapshot；通过现有 adapter 应用 Rime commit/编辑命令，检查焦点离开后 selection、caret 镜像、候选锚点、粘贴和撤销行为。不得在生产控件上移除 focus/lease 守卫。若任一编辑器模型不能可靠恢复 selection，则缩小支持范围或停止该路线。
- **P2-C：原生按键来源原型（仅在 A、B 通过后）。** 分 Windows 与 macOS 评估接收按键事件并映射到现有 `processKey` 的最小原生实验；明确用户显式启用、限定到已登记输入目标、可见退出方式、超时停止、窗口/renderer 销毁时停止、异常 fail-open/fail-closed 决策及不误路由前台按键的验证。Windows 与 macOS 的权限、事件语义和非激活窗口行为分别记录；不假定一端结果适用于另一端。
- **实机基线：** Windows 11 / Electron 29.4.6 先测现有普通聚焦输入和 `showInactive()` 启动；macOS 单列。焦点探针记录 `blur`、`focus`、visibility 和 `hasFocus`，并记录 Answra 自身输入是否完整；探针不是“计数清零”验收器。
- **决策门：** A 失败则停止非聚焦 Rime 路线并保留当前聚焦输入；A 通过但 B 失败则只保留安全的非文本窗口操作评估；A、B 通过后才写独立输入架构 Note，评审是否值得做 C。C 必须证明中文 Rime、编辑器操作与退出恢复完整，再决定是否提出生产改动。

### 当前下一步

P2-A 已证明 librime/helper 能脱离 DOM `keydown` 处理结构化按键并提交中文。下一项是 **P2-B 的隔离编辑器验证**：分别验证 textarea 与 CodeMirror 在 DOM 焦点移出后，是否能用保存的 selection snapshot 正确应用 Rime commit 和编辑命令，并保持 caret、候选锚点与撤销行为。先从 textarea 做最小 harness；通过后再测 CodeMirror。任何一项无法可靠恢复 selection，就记录为限制并缩小可行范围，不修改生产控件的 focus/lease 守卫。

P2-B 不需要用户启动会议应用，也不需要系统级按键钩子。只有 P2-A/B 通过、并另立输入架构 Note 后，才讨论 P2-C 原生物理键盘原型；届时才需要用户在目标 Windows/macOS 环境配合实测。无论阶段如何推进，第三方页面焦点/可见性计数归零都不是验收目标。

参考实现带来的额外约束：

- 非激活浮窗的鼠标交互和键盘输入是两种独立能力；`focusable: false` 可以避免点击激活窗口，但它本身不会让 DOM 收到键盘输入。
- 原生键盘钩子必须有明确的用户启用/退出方式、严格限定生命周期、目标窗口销毁时停止、超时兜底和故障降级。不能在缺少输入目标时继续吞键，也不能把原生窗口/输入钩子的存在误认为页面事件被隐藏。
- Answra 内置 Rime 与系统 CJK IME 是不同输入后端；Rime 引擎可处理结构化按键，但这不自动提供非聚焦窗口的按键来源、DOM selection/caret 或候选锚点。不能把 Natively 的系统 IME 限制误当成 Rime 引擎限制，也不能据此提前断言整条路线不可行。
- 若未来独立评估这类能力，验收必须分别列出平台、OS/Electron 版本、键盘布局/IME、权限状态、按键退出恢复和普通前台应用未误收/未丢失输入的证据；即使通过，也只能描述已测能力，不能承诺第三方站点没有记录焦点或可见性变化。

### 4. P3：处理与焦点无关的其余信号

- 当前主窗口初始尺寸为 `340x60`，允许最大内容尺寸为 `1200x900`（受显示器工作区约束）。本提案暂不改变产品尺寸；需要结合实际使用评估大面板是否遮挡过多，再另行决定折叠/分栏或尺寸上限。尺寸调整不能保证阻止 Chromium 遮挡检测或网页可见性事件。
- 截图流程中主窗口的 `hide()`/恢复显示在各平台单独实测其真实焦点行为；不能预设窗口未激活就必然焦点中性。

### 明确不做

- 不注入、篡改或 hook 第三方页面，不修改浏览器行为，不屏蔽或伪造页面事件；探针只测量并报告真实状态。
- 本提案不交付全局键盘钩子、按键吞噬/转发或按键留存；P2-C 如获准进入，只能是隔离原型，用于评估 Answra 自身输入可用性与故障恢复，不以规避第三方事件为目标。
- 不把“页面失焦/可见性计数为 0”作为产品标准；事件由操作系统、浏览器和页面共同决定，Answra 只承诺自身窗口策略的实际行为。

## 模块边界

- `windowSurfaceRegistry` / `windowInteractionPolicy`：只声明和落实“是否可激活”的平台策略，保持纯函数、可注入、可单测；不感知 IME。
- `mainWindowController`：窗口生命周期与显示方式；不实现输入。
- 当前不新增生产级 `main/input/*` 全局键盘捕获模块。P2-C 原型若通过 A/B 决策门，必须另立输入架构 Note，明确输入授权、作用范围、退出路径和故障时的按键恢复，并独立评审。
- `imeIpc` / `ImeSessionManager`：继续以当前获焦 renderer 输入目标及其 lease 作为键事件来源和权威；本提案不改变 IME 契约。
- `renderer`：只消费 IME 状态与已提交文本；不访问平台 API，不自行实现钩子或焦点伪装。
- `preload`：仅转发现有类型化事件；本提案不增加输入事件通道。

## 曾考虑的替代方案

- **只把 `show()` 改成 `showInactive()`：** 采纳为 P0，用于避免应用主动首次显示时请求激活窗口；它不改变点击输入区时的正常激活语义，也不承诺消除其他页面信号。
- **主窗口永久 `focusable: false` + 全局按键转交内置 Rime：** 不在当前生产范围内，作为 P2-C 的待验证路线保留。Answra 的 Rime 引擎本身可接收结构化按键，因此不能仅凭系统 CJK IME 不可用就否决；但系统级事件源、按键路由、目标授权、selection/caret、候选定位及故障恢复都尚未验证。是否继续由 P2-A/B 的结果决定，不以第三方焦点事件归零为立项理由。
- **照搬 Natively 的 stealth typing：** 作为技术对照保留，不纳入当前决定。该实现依赖平台原生窗口策略和系统级键盘事件通道，并在 CJK IME 活跃时降级；Answra 的 Rime/DOM 输入契约不同，直接移植会改变按键路由并产生新的输入与恢复风险。只有在独立产品需求明确、取得用户授权并完成平台原型后，才重新评估其适用部分。
- **只用 `ToUnicodeEx` 还原字符并写入输入框：** 舍弃。它绕开系统输入法组合，不满足中文输入与编辑器契约。
- **让用户“尽量不要点浮窗”，靠操作习惯规避：** 舍弃。这不是产品行为，截图、发送、再截图本身就要求频繁点击。
- **通过修改第三方页面来控制其焦点或可见性事件：** 舍弃。越界、脆弱且违背“不篡改第三方页面”的边界。
- **只用 `setContentProtection` 认为已经隐身：** 舍弃。它只请求操作系统排除窗口捕获，不改变前台焦点，也不保证第三方会议软件遵守；详见[综合隐身模式提案](2026-10-13-comprehensive-stealth-mode.md)。

## 验收标准

- 可观察结果：首次显示调用非激活显示 API；用户点击输入区后，中英文输入、候选选择、退格、回车和粘贴按现有语义工作；按钮及截图/发送流程的焦点效果通过系统实测记录。当前自动化覆盖策略调用和输入链路未改，首次显示后的 OS 焦点轨迹待实机验证。
- 可观察结果：探针如实分别记录 `blur`/`focus`、`visibilitychange`、`visibilityState` 和 `document.hasFocus()`；结果不被解释为绕过第三方检测或保证事件归零。
- 自动化验证：窗口 controller 单测断言首次显示调用 `showInactive()` 且策略预检失败时不显示；当前生产代码不得增加全局键盘吞键/转发实现。若未来另行批准原生原型，原型测试与正式产品门禁分开记录。运行 `pnpm typecheck`、`pnpm test`、`pnpm architecture:check`、`pnpm notes:check`。
- 已完成的原生引擎验证仅证明 Windows helper/librime 处理合成键值；不可将其表述为已完成非聚焦输入或真实系统焦点验证。
- 需要的实机验证：Windows 11 + Chromium/Edge 探针页，记录启动、文本输入、按钮操作、截图/发送四段的真实事件；macOS 单列验证，不把 Windows 结论外推到 macOS；同时验证任务栏项、第二实例、全屏浏览器（F11）。

## 风险

- `showInactive()` 仅影响显示调用，不承诺鼠标交互永远不激活窗口；行为必须按 Electron/操作系统版本实测。
- 非激活窗口不能直接沿用当前基于 DOM/native focus 的按键接收和 IME lease 恢复语义；Rime 引擎本身可能可复用，但 editor selection/caret、候选锚点和物理按键来源需分别验证。未完成 P2-A/B/C 前，不得宣称非聚焦文本编辑已可用或必然不可行。
- 隐藏本进程窗口会让浏览器重新获得焦点（`focus` 而非 `blur`）；探针应分别记录两者，确认用户工作窗口的完整焦点轨迹。
- 不同 Chromium 的原生遮挡检测会让页面可见性变化；窗口尺寸建议只能降低遮挡范围，不能保证消除事件。
- 不得把 Answra 自身的窗口策略描述成对第三方前端信号、会议软件捕获或平台全局状态的控制能力。
