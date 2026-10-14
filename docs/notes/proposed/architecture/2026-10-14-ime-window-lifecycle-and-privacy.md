# Note：输入法与窗口生命周期、隐私策略

状态：提案

## 问题

内置输入法由 main 进程中的单个 librime session 提供，主窗口和回复窗口各自的 renderer 都能调用全局 enable/disable。某个组件卸载或迟到的 cleanup 可能清空另一个输入框正在使用的 composition。候选窗由独立 BrowserWindow 承载，但目前主要依赖 renderer 上报候选和 DOM focusout 隐藏；外部截图工具改变的是原生窗口焦点，DOM 焦点不一定变化。窗口创建、显示、隐藏、重建和隐身捕获保护由各窗口 controller 分别处理，缺少明确一致的注册和恢复契约。

用户已确认问题由**外部截图工具**触发。不得假设截图会关闭 Answra 面板或卸载 renderer。当前只能确认继续输入变为英文，具体状态转移需通过不含输入内容的生命周期日志及 Windows 实机复现确认。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeIpc.ts`、`rimeBridge.ts`、`imeCandidateWindowController.ts`、`mainWindowController.ts`、`replyBarWindowController.ts`、`windowStealthController.ts`、`apps/desktop/src/preload/index.ts`、`packages/shared/src/channels.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`。
- UI/进程/协议/持久化表面：main/reply/candidate BrowserWindow，renderer/WebContents 生命周期，Rime helper/session，owner lease IPC，隐身捕获保护和焦点切换。
- 相关 Note：[跨平台内置 Rime 输入法桥接](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)、[IME 候选条使用独立原生窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)、[主窗口生命周期与隐身策略拆分](../../implemented/architecture/2026-10-11-main-window-and-stealth-boundaries.md)、[会议场景隐身模式的窗口与捕获边界](./2026-10-13-comprehensive-stealth-mode.md)。

## 根因与架构缺口

- `RimeBridge` 只有一个共享 session，但 `ImeChannels.Enable` 没有 owner token，任一被允许的 renderer 都能修改全局 enabled 状态。
- `useEmbeddedIme` 把组件清理映射为 `imeEnable(false)`；renderer 生命周期与共享引擎生命周期因此耦合。
- 候选窗口 controller 监听 owner 的 move/resize/closed，但没有统一监听 owner 原生 blur/hide/minimize、renderer 导航/崩溃和应用退出。
- DOM focus、BrowserWindow focus 和 IME session ownership 是不同状态，目前没有被明确区分。
- 隐身 controller 统一持有隐身布尔值，但窗口注册、首次显示前策略应用、窗口替换和策略失败后的行为尚无单一契约。

## 提案

采用 main 进程单一协调、窗口 controller 保持专职的设计。窗口生命周期策略和 IME 输入所有权分别由窄职责协调层管理；renderer 只报告自身焦点并持有可撤销 lease。失焦隐藏候选但不销毁 session；owner 真正更换或销毁时清空 composition 并重置中文模式。所有隐私策略在窗口首次显示前应用，并在恢复和隐身状态变化时重验。

以下章节定义状态迁移、窗口策略、退出流程和验证顺序；它们是待评审提案，不代表当前代码已实现。

## 决定草案

### 1. 保留专用窗口 controller，增加窄职责的协调层

不把所有窗口行为塞进一个通用 WindowManager。主窗口、回复窗、候选窗和选择 overlay 继续由各自 controller 管理业务状态、几何位置和自身销毁；新增/强化两个窄协调职责：

- **窗口策略注册表：** main 进程按窗口角色登记活窗口和能力声明；创建、即将显示、恢复显示、隐身切换和销毁时统一应用相应平台策略并移除登记。
- **IME session manager：** 独占 RimeBridge，串行处理 owner lease、按键路由、暂停、重置和最终 dispose。renderer 不再拥有共享 session 的启停权。

两个协调层由 main 装配，不通过全局事件总线互相猜测状态。窗口 controller 通过明确 host 接口注册/注销，测试可注入窗口与策略实现。

### 2. 将焦点和输入所有权拆成三种状态

- **应用原生激活状态：** Electron BrowserWindow 是否 focus/blur、visible/hidden/minimized，由 main 观察。
- **编辑器焦点状态：** 当前 owner renderer 中是否仍有可用的 IME textarea，由该 renderer 显式确认；不能仅靠窗口 focus 推断。
- **IME owner lease：** main 分配的唯一输入 owner 身份和 generation。每个按键、候选状态更新和释放都校验 sender、owner 身份及 generation。

main/reply renderer 可以申请 lease，但同一时刻最多一个 owner。候选窗口不是 owner。旧 owner 的 cleanup、迟到 IPC 或 renderer 重启前的消息不能释放新 generation 的 lease。

### 3. 定义状态迁移和 composition 策略

IME manager 状态：`unavailable`、`idle`、`owned(owner, generation)`、`suspended(owner, generation)`、`disposed`。

- 外部应用抢前台：owner BrowserWindow `blur` 时 main 立即隐藏候选窗，并将 lease 标为 `suspended`；不因此调用 native `enable(false)`，避免普通短暂失焦清空 Rime composition。键盘事件只在有效 owner 的 renderer 且输入框仍确认聚焦时接受。
- 返回 Answra：BrowserWindow `focus` 只允许 renderer 重新确认 editor focus；收到当前 generation 的确认和有效锚点/状态后再恢复候选窗。不能仅因窗口 focus 自动显示过期候选。
- 同一 owner 临时 blur/focus：保留 composition；候选隐藏后按当前 Rime 快照和新锚点恢复。
- owner 切换：main 先隐藏候选并使旧 generation 失效，再处理新 owner。为避免未提交拼音串入另一输入框，切换到不同 owner 时清空 composition，并把 schema 的 `ascii_mode` 明确重置为中文，再授予新 lease。
- owner renderer reload、崩溃、WebContents 销毁或所属窗口关闭：同步隐藏候选、撤销 lease、清空 composition、重置中文模式。不得让恢复后的新 renderer 继承旧 owner 的 ASCII 状态。
- helper 不可用或 IPC owner 校验失败：拒绝按键、隐藏候选并保持系统 IME 隔离；不能回退系统 IME。

若实机验证表明 Rime 无法在短暂失焦期间安全保留 composition，则降级为失焦时清空并重置中文；这是明确的输入内容损失，不可静默改变成英文模式。

### 4. 建立窗口策略生命周期契约

每个 BrowserWindow 创建时声明稳定角色，例如 `main`、`reply`、`ime-candidate`、`selection-overlay`，以及捕获保护和非激活交互能力。注册流程必须在首次显示前完成；显示、恢复、隐身开关变化时重新应用适用策略；关闭和销毁时注销所有窗口/屏幕/电源 listener。

各策略彼此独立：

- 捕获保护由 `windowStealthController`/策略注册表应用并记录结果；`showInactive()` 不代表捕获受保护。
- 非激活交互按窗口角色和平台能力单独启用；输入窗口没有可靠键盘路径时不得为了隐身而设置不可聚焦。
- 候选窗在 owner blur、hide、minimize、close、renderer crash/navigation、隐身切换和 app quit 时先隐藏；恢复展示前重新校验 owner generation、输入焦点、候选状态和捕获保护策略。
- 需要隐身保护的候选内容在保护状态未经应用前不得显示。若平台 API 报告失败，候选窗 fail-closed（保持隐藏）并记录诊断；不能将 `setContentProtection` 调用成功等同于所有第三方录屏绝对不可见。

### 5. 明确应用退出、重启和注销

- 应用正常退出：停止接受新 lease/按键，先隐藏并销毁候选窗，再撤销 owner、清空 composition、结束 Rime helper，最后注销窗口策略及事件监听。
- renderer reload/crash：只使该 WebContents 的 lease 失效，不重启整个应用；下一 renderer 必须重新握手并获得新 generation。
- 窗口重建：新 BrowserWindow 使用新身份，重新注册窗口策略；旧窗口事件不得操作新实例。
- OS 注销/关机：依赖 Electron/app 可观测的退出通知做有序清理，但不把可靠性建立在收到通知上；子进程必须随父进程退出，不持久化 preedit/candidate 到磁盘。若系统强制终止，重启后从 `idle`、中文模式和无候选状态开始。

### 6. 限制诊断信息

生命周期日志仅记录窗口角色/id、owner generation、状态迁移、可见/聚焦状态、策略结果和原因码。不得记录按键文本、preedit、候选词、草稿、截图或对话内容。日志要能判断“外部 blur -> 候选隐藏 -> focus -> editor 重新确认 -> lease 恢复/拒绝”的顺序。

## 模块边界

- `imeSessionManager.ts`：唯一持有 RimeBridge；owner lease 和状态迁移的纯规则尽量拆为可单测 reducer/纯函数。
- `imeIpc.ts`：只校验 sender/lease、解码 typed request 并调用 manager；renderer 不传任意 owner 身份替代 main 校验。
- 各窗口 controller：拥有本窗口创建/加载/显示/关闭和业务状态，报告真实生命周期事件，不直接管理 Rime session。
- `windowPolicyRegistry.ts`：按角色注册、注销并在生命周期节点应用 capture/non-activating 策略；策略实现可注入测试。
- `windowStealthController.ts`：唯一拥有隐身模式状态，驱动策略注册表，不读取 renderer DOM 状态。
- preload/shared：定义 typed lease acquire/release/focus confirmation 与有限 IME 消息；只做转发。
- renderer hook：拥有 textarea 的 draft/DOM focus；挂载时申请、卸载时释放自己的 lease；清理只能释放对应 generation，不能全局 disable。

## 分阶段实施

1. **观测与纯状态模型：** 增加不含内容的生命周期诊断；定义 owner/generation 和窗口角色策略类型；为 blur、focus、owner switch、stale cleanup、renderer crash、app quit 建纯函数测试。不改变用户输入行为前先得到可复现事件序列。
2. **IME owner lease：** 将无主全局 enable/disable IPC 改为 acquire/release/confirm-focus；main 串行路由并拒绝迟到消息；实现 owner 切换清空并重置中文。覆盖主窗口和回复窗口交错、React StrictMode cleanup、快速 owner 切换和 helper 故障。
3. **原生焦点和候选隐私：** 候选窗接入 owner blur/hide/minimize 与 renderer lifecycle；focus 后必须等当前 owner 确认 editor focus 和新锚点才显示。捕获保护在候选首次 show 前检查，隐身切换及窗口恢复重新应用。覆盖 external screenshot 场景。
4. **全窗口策略生命周期：** 将主、回复、候选和选择窗口纳入按角色注册表；覆盖创建、ready-to-show、show、restore、close、recreate 和退出；确保没有重复 listener 或已销毁窗口回调。
5. **Shift 行为独立变更：** lifecycle 稳定后再增加 Shift keysym 和 ascii mode 可观察状态；不与 lease 架构变更同批上线。

## 曾考虑的替代方案

- **把所有 BrowserWindow 收进一个万能 WindowManager：** 舍弃。不同窗口有独立几何、交互和业务生命周期，万能管理器会重新耦合；共享的只应是可声明、可测试的平台策略。
- **继续让每个 renderer hook 直接 enable/disable Rime：** 舍弃。renderer 卸载与共享 session 生命周期不同步，迟到 cleanup 可影响其他窗口。
- **窗口 blur 时销毁 session：** 舍弃。外部截图是短暂系统焦点切换，销毁会丢失拼音并产生状态漂移；blur 只暂停展示和按键路由。
- **owner 切换时保留 composition 并让新输入框接管：** 舍弃。预编辑文本可能写入错误草稿，且新 renderer 不拥有旧 composition 的编辑上下文；切换时明确清空更可预测。
- **仅依赖 DOM `focusout` 管理候选隐私：** 舍弃。原生窗口失焦不保证 DOM focus 变化；候选隐私由 main 观察 BrowserWindow 生命周期，renderer focus 作为再次显示的必要确认。
- **所有窗口统一设置 `setFocusable(false)`：** 舍弃。没有可靠键盘通道时会让输入不可用；捕获保护与交互策略是独立能力。

## 验收标准

- 可观察结果：外部截图期间候选立即隐藏；回到 Answra 后只有当前输入框重新确认焦点才恢复。短暂失焦不改变中文/英文模式；owner 切换、renderer 重启或窗口关闭后清空未提交拼音并回到中文模式。
- 可观察结果：主、回复、候选、选择窗口每次创建/恢复时按角色重新应用隐身策略；隐身下候选保护未确认前不会显示；关闭/重建/应用退出后无可见残留候选窗、悬挂 IPC 或多余 listener。
- 自动化验证：IME 状态模型、lease 代次、sender 授权、迟到 acquire/release、focus 和 DOM focus 不同步、owner switch、helper crash、window destroy/recreate、退出顺序及策略注册表生命周期均有测试。
- 自动化验证：`pnpm notes:check`、`pnpm verify`、桌面构建和 `git diff --check` 通过。
- Windows 实机验证：Windows 11 22631 + 当前 Electron 版本；使用系统截图快捷键及至少一种外部截图工具，覆盖 composition 中截图、取消/完成、切回、截图期间多次切换焦点、窗口隐藏/恢复、renderer reload/crash、应用重启和注销/登录。
- 隐私实机验证：检查主、回复、候选窗口在启用/关闭隐身及捕获工具窗口/屏幕捕获中的表现；分别记录 Electron API 策略结果和第三方工具实际结果，不将前者当作后者的保证。

## 风险

- 外部截图工具不受 Answra 控制；系统可能在 blur 事件被处理前捕获一帧。应用应在原生 blur 到达时立即隐藏候选窗并使用平台捕获保护，但不能承诺对所有截图驱动绝对不可见。
- Electron、Windows DWM 和会议软件对 capture exclusion 的支持不同；每个受支持平台/目标软件都需实测并在诊断中区分“请求应用”和“实际未捕获”。
- 注销/强制关机可能不提供完整 graceful shutdown 时间；安全性依赖不把 preedit 持久化、候选窗随宿主进程终止以及启动时清洁初始化。
- owner 切换清空未提交 composition 会损失少量输入，但避免文本串入错误会话和继承 ASCII 状态；UI 可在需要时给出简短、明确的状态反馈，不得静默改变输入模式。

## 当前实现差距

本文是待实施方案，不表示当前已有统一 lease 或策略注册表。当前已有的 `mainWindowController`、`replyBarWindowController`、候选窗口 controller 和 `windowStealthController` 仍分别管理生命周期；隐身 Note 中的窗口策略注册表也仍是提案。实施前需以当前分支代码和 Windows 复现日志验证以上状态迁移，不应把本方案中的假设当成已经证实的根因。
