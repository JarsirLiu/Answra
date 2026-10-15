# Note：会议场景隐身模式的窗口与捕获边界

状态：提案

## 问题

会议场景下，用户需要在 Answra 上查看和操作 AI 辅助内容，同时让会议对方看到的共享画面保持不变。这里存在两个容易混淆的风险：

1. Answra 窗口内容可能进入会议软件的屏幕或窗口捕获。
2. 点击 Answra 窗口可能把 Windows 前台焦点从 Zoom、Teams 或浏览器切走，导致会议软件失焦、输入位置变化或用户感知到工作流被打断。

`setContentProtection` 只处理第一个风险，`showInactive` 只能降低部分显示路径的激活风险，不能保证鼠标点击永远不激活窗口。全局隐藏系统鼠标又会损害本地操作体验，且不能可靠控制会议软件是否捕获鼠标指针。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/mainWindowController.ts`、`apps/desktop/src/main/replyBarWindowController.ts`、`apps/desktop/src/main/capture/selectionWindow.ts`、`apps/desktop/src/main/windowStealthController.ts`、`apps/desktop/src/main/windowCaptureProtection.ts`
- 未来模块：Windows 非激活窗口策略、原生键盘输入转发、服务窗口注册表、隐身诊断
- UI/进程/协议/持久化表面：主窗口、回复条、截图框选 overlay、动态创建的 Electron/原生辅助窗口；不改变对话协议和截图一次性会话语义
- 相关 Note：`docs/notes/implemented/architecture/2026-10-11-main-window-and-stealth-boundaries.md`、`docs/notes/implemented/bug-fix/2026-10-11-electron-capture-protection-compatibility.md`

## 提案

### 1. 将隐身拆成两个明确能力

隐身 controller 继续作为唯一状态所有者，但内部明确区分：

- **捕获保护（capture protection）：** 窗口内容不参与系统捕获。每个 `BrowserWindow` 创建后、首次显示前、恢复显示后和必要的生命周期变化后都应用保护。
- **非激活交互（non-activating interaction）：** 鼠标点击或显示 Answra 不改变会议软件的前台焦点。该能力按窗口类型和平台声明，不由 UI 代码自行调用 `focus()` 或 `show()` 猜测实现。

两种能力分别报告状态。捕获保护成功不代表会议软件一定遵守，也不代表焦点策略已经生效。

### 2. 建立可注册的窗口策略表

新增一个纯策略模块，定义每个窗口的能力声明，例如：

- `main`：捕获保护；Windows 非激活仅在键盘输入通道可用时启用。
- `reply-bar`：捕获保护；同上；显示使用 `showInactive()`。
- `selection-overlay`：捕获保护；Windows 优先启用非激活窗口，因为框选依赖鼠标而不依赖文本输入。
- 未来新增的设置、菜单、诊断或临时窗口：创建时必须注册，不能只依赖全局布尔值。

controller 负责把策略应用到窗口生命周期，窗口业务 controller 只提供窗口实例和生命周期回调。这样新对话页面或新浮层可以复用同一策略，不会遗漏隐身处理。

### 3. Windows 分阶段接入 `WS_EX_NOACTIVATE`

第一阶段只对截图选择 overlay 接入 `setFocusable(false)` 对应的 `WS_EX_NOACTIVATE`，并在 `blur`/`hide` 时重新确认不可激活。显示使用 `showInactive()`；必要时使用不激活的置顶方式恢复层级，不调用 `focus()`。

第二阶段在原生低级键盘钩子或等价可靠输入通道完成并通过实机验证后，再把主窗口和回复条纳入永久非激活策略。没有键盘转发能力时，不得简单设置 `setFocusable(false)`，否则输入框会变成不可用。

键盘转发必须属于独立平台模块，renderer 只接收已校验的按键事件；不得把 Electron/Node 或 Windows API 引入 renderer。

### 4. 保留并加强捕获保护

隐身开启后：

- 主窗口、回复条、选择 overlay 都调用 `setContentProtection(true)`。
- 每个窗口在 `ready-to-show` 前后、`show`/`restore`、重建和隐身切换时重新应用。
- 对已知的非 `BrowserWindow` 原生窗口，若未来引入原生模块，应提供独立的 foreign-window guard；不能把系统对话框误认为 BrowserWindow 已受到保护。
- 不通过过滤 DXGI/Chromium 日志来宣称保护成功。日志只用于诊断，不能改变捕获行为。

### 5. 鼠标指针采用应用边界内的处理

Answra 不全局隐藏系统鼠标。这样能保持本地拖拽、点击和会议操作正常。会议端是否显示鼠标指针由 Zoom、Teams 等会议软件的共享设置决定；应用不能通过 Electron 公共 API 实现“本地可见、共享端单独不可见”。产品诊断可以提示用户关闭“共享鼠标指针/显示鼠标光标”，但不能把该设置当成应用已完成的能力。

### 6. 增加隐身诊断而不是静默猜测

隐身状态诊断至少包含：

- 每个受管窗口的窗口类型、原生句柄、可见性、捕获保护请求/读取状态；
- Windows 非激活策略是否启用及其原因（平台不支持、键盘通道不可用或成功）；
- 最后一次策略应用时间和窗口重建次数。

诊断只输出元数据，不记录对话内容、截图、提示词或按键文本。设置页可以显示“窗口捕获保护”和“点击不抢会议焦点”两个独立状态，避免把一个能力的成功误认为另一个能力成功。

## 当前实施进度

本次先交付第一阶段：

- 新增 `apps/desktop/src/main/windowInteractionPolicy.ts`，集中封装 Windows 非激活策略、平台判断和键盘通道不可用时的安全回退。
- 截图选择 overlay 在 Windows 上创建后立即应用非激活策略，并使用 `showInactive()` 显示；隐身捕获保护保持不变。
- 主窗口和回复条暂不设置 `setFocusable(false)`，因为当前还没有经过验证的原生键盘转发通道；它们继续保持可输入。
- 新增策略单元测试，并覆盖截图窗口的创建路径。
- Windows 的截图 overlay 使用非激活策略后无法接收自身 DOM 的 Escape 键事件；截图会话由 main process 临时注册全局 Escape，并在完成、取消或失败时注销，保持取消能力且不激活 overlay。
- 主窗口和回复条的永久非激活仍暂缓。优先验证中文 IME 候选/联想窗是否进入会议共享，以及回复条在不抢焦点的前提下可接受哪些输入方式；原生键盘钩子本身不视为中文输入方案。
- 两个 renderer 根部接入 `useStealthInputGuard`：隐身开启时阻止 `input`/`textarea`/`contenteditable`（包括 CodeMirror）获得焦点或接收键盘输入，关闭隐身后恢复；按钮、滑块和选择控件继续可用。
- 系统组件选择器纳入禁止范围：renderer 阻止 `input[type=file]` 的直接或程序化打开，workspace main IPC 在隐身时拒绝目录 `showOpenDialog`；隐身关闭后恢复。
- BrowserWindow 共享捕获策略已由 `windowSurfaceRegistry` 统一登记，四类现有窗口都在显式显示前检查策略，并在 show/restore/resize 和隐身切换时重应用；层级、non-activating 交互和原生焦点事实也在同一 surface 登记入口管理。新增窗口由 `architecture:check` 检查登记和显示前预检。

提案仍保持 `proposed`，直到主窗口/回复条的键盘通道、动态辅助窗口和 Zoom/Teams 实机矩阵完成验证。

## 模块边界

- `windowStealthController.ts`：持有隐身状态，协调策略注册表和捕获保护，不管理具体 UI 业务。
- `windowCaptureProtection.ts`：只封装 Electron/OS 捕获保护及其诊断。
- 新的 `windowInteractionPolicy.ts`：只定义平台相关的非激活策略和能力结果，保持可注入、可单测。
- 各窗口 controller：创建窗口、注册窗口类型、处理自身的尺寸和业务事件；不得复制隐身判断。
- `preload`：只转发类型化事件；键盘通道的业务决策不放在 preload。
- `renderer`：不依赖 Electron、Node 或平台 API。

## 曾考虑的替代方案

- **全局隐藏系统鼠标：** 舍弃。它改变本地操作体验，不能保证会议软件的光标捕获行为，也不能解决窗口抢焦点。
- **所有窗口直接 `setFocusable(false)`：** 舍弃。没有可靠键盘转发时会使主窗口和回复条无法输入；截图 overlay 可以单独采用，但不能作为全局方案。
- **只调用 `showInactive()`：** 舍弃。它只覆盖显示路径，鼠标点击、窗口激活和部分平台原生窗口仍可能改变前台焦点。
- **只依赖 `setContentProtection(true)`：** 舍弃。它处理共享内容，不处理前台焦点；部分会议软件也可能不完全遵守操作系统捕获排除标志。
- **复制其他项目的原生键盘钩子而不做能力探测：** 舍弃。钩子可能因构建产物、权限、架构或安全软件不可用；必须失败可诊断，并回退到可输入的焦点策略。
- **让会议软件通过设置隐藏鼠标：** 作为用户侧配合保留，不作为 Answra 内部实现。Electron 没有公共 API 可以替会议软件修改其共享指针策略。

## 影响表面

- 会议期间点击回复条或截图 overlay 时，目标会议软件应继续保持前台焦点。
- 截图框选不应因为打开 Answra 而触发会议软件失焦。
- 在键盘通道不可用时，应用必须保留可用输入，并明确报告“非激活交互未启用”。
- 隐身关闭后，窗口恢复普通捕获和交互行为；不得残留不可激活或任务栏隐藏状态。
- 新增窗口必须通过注册表声明捕获保护和交互策略，否则架构测试应失败或至少在诊断中可见。

## 验收标准

- 可观察结果：Windows 会议中点击、拖拽截图 overlay 不使 Zoom/Teams/浏览器失去前台焦点；主窗口和回复条在输入可用的前提下不抢焦点。
- 可观察结果：隐身开启时主窗口、回复条和截图 overlay 在目标会议软件共享画面中不可见；隐身关闭后恢复正常。
- 可观察结果：系统鼠标仍可在本地正常使用；不承诺应用单方面隐藏会议软件捕获的鼠标指针。
- 自动化验证：策略模块覆盖平台判断、窗口注册、生命周期重应用、键盘通道不可用时的安全回退；窗口 controller 覆盖 `showInactive`、不调用 Windows `focus()` 和捕获保护调用。
- 自动化验证：`pnpm typecheck`、`pnpm test`、`pnpm architecture:check`、`pnpm notes:check`、`git diff --check`。
- 实机验证：Windows 11 22631 及 Electron 29.4.6，至少使用 Zoom 或 Teams 共享整个屏幕、共享窗口两种模式；验证点击、拖拽、输入、切换隐身、窗口重建和多显示器。
- 实机验证：在 8-bit 和 10-bit 显示输出、混合 DPI、会议软件显示/隐藏鼠标指针两种设置下记录结果；DXGI 诊断日志只能作为环境信息。

## 风险

- `setContentProtection` 是操作系统提示，不是对所有录屏或会议实现的绝对保证；必须按目标会议软件做实机验证。
- Windows 低级键盘钩子可能被权限、架构、构建产物或安全软件阻止；因此非激活策略必须有能力探测和可用输入回退。
- 不同会议软件对“共享窗口”“共享屏幕”“共享鼠标指针”的实现不同，无法由 Answra 单一 API 统一控制。
- 非激活窗口的层级和多显示器行为可能受 DWM、混合 DPI 和会议软件浮动工具栏影响；需要记录实际窗口句柄和边界，不能只看内存状态。
- 周期性重应用保护会增加少量窗口 API 调用；应在窗口集合变化时更新并去重，避免无界定时器或重复监听器。

## 后续实施顺序

1. **已完成：** 窗口策略注册表和静态接入门禁，详见[原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)。
2. 给截图选择 overlay 接入 Windows 非激活策略并补测试、实机验证。
3. 设计并验证键盘输入转发，再评估主窗口和回复条的永久非激活策略。
4. 将未来动态服务窗口纳入同一注册边界，补齐 renderer reload/crash 恢复及窗口重建测试。
5. 完成 Zoom/Teams 实机矩阵后，将本提案迁移到 `implemented/`，记录实际限制和防回退规则。
