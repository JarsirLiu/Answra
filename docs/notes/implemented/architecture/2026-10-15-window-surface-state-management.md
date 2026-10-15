# Note：原生窗口 surface 状态统一管理

状态：已实施

## 问题

主悬浮栏、回复栏、IME 候选窗和截图选择层由不同 controller 创建。捕获保护由 `windowPolicyRegistry` 集中应用；窗口层级和 non-activating 交互则散落在各 controller/helper 中。IME lease 还单独监听 BrowserWindow 的 blur/focus。相同窗口的捕获策略、层级、交互能力和原生焦点事件因此没有统一的登记入口，增加窗口或改变 owner 时容易漏掉其中一部分。

用户观察到候选内容和输入行为已经生效，但候选 UI 偶尔被应用窗口遮住；切换电脑上的其他应用再返回后，候选 UI 才显示出来。当前实现表明候选窗有较高的 Electron 层级并绑定当前输入窗口，但 `isVisible()`、`isAlwaysOnTop()` 和现有日志都不能证明 Windows 桌面合成器最终显示的 HWND 顺序。候选窗 owner 重新获得焦点时目前只记录状态，没有经共享层级策略重新校准候选窗与 owner 的原生关系。

用户观察到候选内容和输入行为已经生效，但候选 UI 偶尔被应用窗口遮住；切换电脑上的其他应用再返回后，候选 UI 才显示出来。当前实现表明候选窗有较高的 Electron 层级并绑定当前输入窗口，但 `isVisible()`、`isAlwaysOnTop()` 和现有日志都不能证明 Windows 桌面合成器最终显示的 HWND 顺序。候选窗 owner 重新获得焦点时目前只记录状态，没有共享的 surface 策略入口重申候选窗与 owner 的原生关系。

需要统一的是 BrowserWindow 层级、捕获保护、交互策略和原生窗口焦点事实；DOM 输入控件焦点、IME lease owner、Rime composition 和候选锚点属于不同层次，必须保持各自明确的权威状态。统一 surface 状态管理可能修复应用内激活顺序导致的遮挡，并减少窗口策略漂移，但不能仅凭 Electron 状态断言已经解决；最终可见顺序仍须实机验证。

## 涉及范围

- 代码/模块：拟新增的 `apps/desktop/src/main/windowSurfaceRegistry.ts`、`window.ts`、`windowStealthController.ts`、`windowInteractionPolicy.ts`、各 BrowserWindow controller、`ime/imeIpc.ts` 及对应 `apps/desktop/test/` 和架构守护脚本。
- UI/进程/协议/持久化表面：main 进程 BrowserWindow 角色登记、层级、捕获保护、non-activating 策略和原生焦点事件；IME lease 继续拥有 renderer 输入目标焦点与 composition。IPC 载荷和持久化格式不变。
- 相关 Note：[原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)、[IME 候选条使用独立原生窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)、[统一 IME 输入目标与窗口生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)。

## 决定

将目前的 `windowPolicyRegistry` 扩展并改名为 `windowSurfaceRegistry`，作为 main 进程 BrowserWindow 策略与原生生命周期事件的唯一登记入口。每个窗口在创建后登记明确角色；registry 统一应用该角色的捕获保护、always-on-top 层级及 non-activating 交互策略，并追踪原生 focus/blur/visibility 状态。registry 不创建窗口，也不接管各 controller 的业务状态、位置或显隐决定。

首批角色采用显式、有限的策略，不使用散落的字符串或数字层级：

- `main`、`reply-bar`：应用悬浮 surface，沿用当前 `floating` 层级，可接收键盘焦点。
- `ime-candidate`：输入提示 surface，沿用当前 `pop-up-menu` 层级；必须绑定当前 IME owner，并保持非激活、不可聚焦。
- `selection-overlay`：模态截图选择 surface，沿用当前 `screen-saver` 层级，压过普通应用 surface 和候选窗，并保持非激活。

候选窗口 controller 继续拥有候选 BrowserWindow 和业务生命周期。它通过 registry 声明/更新当前 owner，并在候选窗即将显示及 owner 重新获得焦点时请求一次层级 reconciliation。reconciliation 只处理已登记窗口，按角色策略重新应用 Electron 层级，并确认候选窗仍以当前 owner 建立原生父子/owned-window 关系。owner 变化时先解除旧关系，再绑定新 owner；owner 销毁时清理关系。候选 renderer 未就绪、IME lease 已失效、owner 不可见或捕获保护策略拒绝显示时，不得借层级恢复路径显示窗口。

统一 surface API 应表达窗口角色与业务关系，例如 `register(window, descriptor)`、`attachAbove(child, owner)`、`prepareToShow(window)` 和原生焦点状态订阅；各调用方不得直接调用 `setAlwaysOnTop`、`setParentWindow` 或 `setFocusable`。Electron level 到平台具体行为的映射集中在 registry 内，并保留角色语义，避免 controller 自行挑选层级。

层级恢复不得调用 `moveTop()`。此前候选窗置顶实验曾导致候选 UI 完全不出现；因此本提案不重新引入该调用。任何需要更激进的原生 z-order 操作，须先以单独实验验证 Windows owner/owned-window 行为和候选 renderer 生命周期，再经独立决策评审。

已实施部分将四类 surface 的角色、捕获保护、always-on-top 层级、non-activating 属性和原生 focus/blur 事件纳入 `windowSurfaceRegistry`。候选 owner 关系通过 `attachAbove` 维护，并在 owner 重新获得焦点时重申层级；候选业务 controller 不再另行决定 blur 后的 IME lease 状态。IME lease 通过 registry 的原生焦点事件做 suspend 判断，renderer DOM focus confirmation 仍是恢复输入的必要条件。

窗口创建、位置、业务显隐和 renderer ready 仍由专职 controller 管理。窗口重建、应用前后台切换与跨窗口 IME owner 转移不合并进 surface registry；只有测试或线上日志证明存在状态竞争时才另行扩展，避免形成全能 window manager。

诊断日志只在 owner 变化、reconciliation 失败或窗口原生焦点/显隐状态转换时记录角色、windowId、ownerWindowId 和策略结果，不记录按键、输入内容或高频轮询状态。

## 模块边界

- `windowSurfaceRegistry.ts`：持有 `BrowserWindow -> role` 登记、捕获保护模式、always-on-top 层级、交互策略、候选 owner 原生关系和原生窗口焦点快照；校验合法角色组合，执行显式 reconciliation，在关闭时清理关系和监听。不得持有候选内容、输入 target、窗口坐标、Rime 状态或 renderer IPC。
- `windowStealthController.ts`：持有隐身模式开关并通知 surface registry 更新捕获保护；不直接枚举或操纵窗口原生层级。
- `windowInteractionPolicy.ts`：保留平台能力检测和策略纯函数；BrowserWindow 的实际交互属性由 surface registry 应用和清理。
- 各窗口 controller：创建并销毁自己的 BrowserWindow；声明角色；在具体生命周期节点请求显示许可或 owner reconciliation；保留业务显隐、位置、IPC 和 renderer ready 逻辑。
- `imeCandidateWindowController.ts`：唯一决定当前候选 owner 的业务 controller；只把已经通过 lease 校验的当前 owner 交给层级 registry，不允许候选 renderer 指定任意 BrowserWindow。
- IME lease manager：继续持有唯一 renderer 输入目标 owner、generation、composition 生命周期和 Rime 操作序列；订阅 registry 的原生 BrowserWindow focus/blur 事实并作 lease 状态判断。DOM focus confirmation 仍由 renderer 发送，不能由 BrowserWindow focus 推断。

## 曾考虑的替代方案

- **只把现有 `setAlwaysOnTop` 调用搬到一个公共函数：** 舍弃。它只减少重复代码，不表达捕获、交互和原生焦点生命周期，也不会在 owner 重新激活时修复相对顺序，无法覆盖本次观察到的管理缺口。
- **让一个万能 WindowManager 接管所有 BrowserWindow 的创建、定位、显示和关闭：** 舍弃。registry 只统一跨窗口策略与原生状态事实；各窗口的业务状态、几何、显隐决定和 renderer ready 差异仍由专职 controller 持有。扩大 registry 职责会让截图、回复、候选和主窗口互相耦合。
- **继续由每个 controller 自行组合捕获、层级和交互策略：** 舍弃。角色策略分散后难以审查和测试，新窗口容易漏配；候选 owner 重绑定及窗口焦点监听也没有统一约束。
- **在每次按键、定时器或每帧布局时反复置顶：** 舍弃。高频原生窗口操作会增加闪烁和焦点回归风险，且不解决层级规则归属；仅在创建/绑定、显示前、owner 激活及关系变化时显式 reconciliation。
- **通过 `moveTop()` 强制候选窗置顶：** 拒绝。此前实验导致候选 UI 不再出现；它也没有清楚表达候选窗必须位于当前输入 owner 之上的关系。

## 验收标准

- 可观察结果：候选窗跟随当前输入 owner；在主窗口或回复窗口作为输入 owner 时，候选窗均显示在该输入 surface 上方；应用内 owner 重新激活后候选窗仍在上方；切换 owner 后不再附着旧窗口；截图选择层仍覆盖候选窗；候选窗保持非激活，键盘焦点留在输入控件。
- 自动化验证：覆盖角色策略矩阵（捕获/层级/交互）、隐身切换、show/restore/resize 生命周期、原生 focus/blur 事件的单一分发及注销、非法角色/owner 组合拒绝、候选 owner 首次绑定和切换、owner 关闭解绑、candidate show 前和 owner focus 后的 reconciliation 顺序、候选 renderer 未 ready/捕获保护拒绝时不显示，以及截图 overlay 高于候选窗的策略关系。IME lease reducer/IPC 测试继续验证原生焦点事实到 suspended/owned 转移及 renderer focus confirmation 不被绕过。自动化测试不以 mock 的 `isAlwaysOnTop()` 结果冒充原生窗口顺序。
- 需要的实机验证：Windows 11 + Electron 29.4.6，分别用主窗口与回复窗口输入；首次打开、owner 重新聚焦、候选更新、owner 切换、截图选择 overlay 显示/关闭和外部应用切换后观察候选条是否被覆盖或闪烁。至少验证 100% 和 150% DPI；记录实际复现步骤和可见结果。若系统无法提供可靠原生 z-order 观测 API，实机视觉验证是验收依据，Electron 查询状态仅作辅助证据。

## 风险

- Electron 的 `setAlwaysOnTop` level 在不同平台的映射和可用性不同；首批契约需明确平台支持矩阵。当前产品主要目标是 Windows，但不能将 Windows 假设暗藏在通用 controller API 中。
- `setParentWindow`/owned-window 关系会影响关闭和焦点行为。必须保持候选窗不可聚焦且通过 `showInactive()` 展示，并在 owner 变更、owner 关闭和 candidate teardown 中对称清理。
- 主窗口、回复栏和候选窗使用相近的 always-on-top 范围时，实际 Windows z-order 仍可能受激活顺序、窗口 owner 和其他原生窗口影响。统一 registry 可以让策略可审查并在生命周期节点重申关系，但不能保证压过系统对话框或其他进程窗口。
- 隐身捕获保护与窗口层级相互独立。层级恢复不得绕过 `prepareWindowToShow`，也不得在候选 owner 失焦到其他应用时重新显示候选窗。
- BrowserWindow 焦点与 renderer 输入目标焦点不同。registry 只分发原生焦点事实；只有当前 IME lease manager 可以决定 suspend/resume，恢复输入必须等待当前 renderer 再次确认 DOM focus。
- 诊断日志必须保持低噪声；不得记录候选文字、preedit、按键内容或高频轮询结果。

## 后果与防回退

- 新建 `BrowserWindow` 必须登记明确 surface role，并在显示前经过 `prepareWindowToShow`；架构检查强制要求这两个接入点。
- 各 controller 不得直接设置 always-on-top level、native parent 或 focusability；对应策略只在 `windowSurfaceRegistry` 的角色表和 owner API 中维护。
- 候选窗只允许绑定已登记的 `main` 或 `reply-bar` owner；绑定只发生在创建、owner 切换和显式 reconciliation，不得在按键/布局高频路径重复设置 native owner。
- 原生 BrowserWindow focus/blur 事实由 registry 统一分发；IME lease manager 是 suspend/resume 和输入目标 owner 的唯一权威。候选 controller 不得独立推断 renderer 输入焦点或清理 Rime composition。
- 隐身捕获保护、窗口层级、non-activating 交互分别执行。z-order reconciliation 不得绕过捕获策略许可，也不得调用 `moveTop()` 或在应用失焦时重新显示候选窗。
- Electron 的可见/always-on-top 查询只作诊断；不得以这些值代替 Windows 实际窗口顺序验收。

## 验证

- `pnpm verify` 通过：Biome、Note 门禁、全包 typecheck、app 7 项测试、UI 120 项测试、desktop 112 项测试、架构检查均通过。
- `windowSurfaceRegistry.test.ts` 覆盖角色策略、捕获保护切换、原生焦点订阅、候选 owner 绑定/替换/解绑、焦点恢复时层级 reconciliation、fail-closed 和 listener 清理。
- `imeIpc.test.ts` 覆盖共享原生焦点事件触发 lease suspend；候选 controller 测试覆盖候选状态、owner 路由及 renderer ready 生命周期。
- 自动化 mock 不能证明 Windows 实际 HWND z-order。Windows 11 + Electron 29.4.6 实机验收仍待用户执行；本次未启动应用，也未声称候选 UI 遮挡问题已实机解决。
- `git diff --check` 通过。

