# Note：原生窗口生命周期与共享策略注册

状态：已实施

## 问题

桌面端已有主窗口、回复窗口、IME 候选窗口和截图选择窗口。它们各自创建 BrowserWindow，并分别应用捕获保护、恢复显示和关闭清理。新增窗口容易漏掉隐私策略；重复监听和窗口重建也缺少统一登记点。页面与原生窗口的生命周期边界也需要明确，避免每加一个页面就创建一套窗口基础设施。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/windowSurfaceRegistry.ts`、`window.ts`、各 BrowserWindow controller、`capture/selectionWindow.ts`、`windowStealthController.ts`、`ime/imeIpc.ts`、`scripts/architecture/architecture-check.mjs`。
- UI/进程/协议/持久化表面：main 进程的窗口实例、捕获保护生命周期、隐身切换和 controller teardown；不改变 renderer 页面路由及 IPC 业务协议。
- 相关 Note：[主窗口生命周期与隐身策略拆分](../../implemented/architecture/2026-10-11-main-window-and-stealth-boundaries.md)、[会议场景隐身模式的窗口与捕获边界](../../proposed/architecture/2026-10-13-comprehensive-stealth-mode.md)、[统一 IME 输入目标与窗口生命周期](./2026-10-15-unified-ime-target-lifecycle.md)。

## 决定

每个原生窗口仍由专职 controller 创建并管理业务状态、几何和显隐；main 进程的 `windowSurfaceRegistry` 统一登记窗口角色、捕获策略、always-on-top 层级、non-activating 交互策略、原生 owner 关系及 BrowserWindow focus/blur 事件。注册表在登记、显示/恢复和显式 owner reconciliation 时应用相应窗口策略；resize 与隐身切换更新捕获保护；窗口关闭时撤销 listener、焦点订阅和 owner 关系。敏感窗口在实际调用 `show`/`showInactive` 前执行 `prepareWindowToShow`，策略失败时保持隐藏。

UI 页面继续由 renderer 路由管理。只有需要独立原生位置、焦点、z-order 或捕获策略的 surface 才创建 BrowserWindow。页面卸载不能直接销毁应用级共享服务。

窗口角色首批固定为 `main`、`reply-bar`、`ime-candidate`、`selection-overlay`。各角色的层级和交互能力由 registry 内的策略表唯一声明。BrowserWindow 原生焦点事件由 registry 统一分发；DOM 输入控件焦点、IME lease owner 和 Rime composition 仍归 IME lease manager，不能从 BrowserWindow focus 推断。

## 生命周期契约

1. 创建 BrowserWindow 时同步注册 role 和捕获策略；初始 `show` 必须为 false。
2. 首次及后续显式显示前 controller 调用 `prepareWindowToShow`；未登记窗口和 fail-closed surface 的策略失败均拒绝显示。
3. `show`、`restore` 和 `resize` 事件重应用当前策略，覆盖原生恢复及尺寸变化路径。
4. 隐身状态改变时注册表逐个更新所有存活窗口；新窗口读取当前状态，不依赖先前广播。
5. `closed` 时注册表移除监听和登记。controller 仍须清理自己注册的业务 listener 和资源。
6. renderer 页面改变不等于 BrowserWindow 销毁；renderer reload/crash 后恢复业务状态不属于本阶段。
7. 注册表和 Electron API 结果不承诺操作系统会阻止所有第三方录屏；外部捕获实测必须分别陈述。

## 模块边界

- `windowSurfaceRegistry.ts`：main 进程唯一原生 surface 登记点；集中角色策略、捕获保护、z-order、non-activating 交互、原生 owner 关系、原生焦点事件分发和 teardown。
- 各窗口 controller：拥有对应 BrowserWindow 的创建、加载、业务状态、位置和显隐；声明角色，在显示前请求策略许可，并在业务 owner 变化时请求关系更新。
- `windowStealthController.ts`：持有隐身模式状态并通知窗口注册表；任务栏/Dock 等应用级策略仍在此处。
- `windowInteractionPolicy.ts`：只提供平台能力判断；BrowserWindow 的交互属性由 `windowSurfaceRegistry` 统一应用。
- IME lease manager：订阅 registry 的原生窗口 focus/blur 事实，决定 lease suspend/resume；renderer DOM focus confirmation 仍是恢复输入的必要条件。
- renderer 页面：只管理页面/组件生命周期，不直接控制 BrowserWindow 或应用级共享 session。

## 曾考虑的替代方案

- **万能 WindowManager 接管所有窗口业务：** 舍弃。主窗、回复条、候选条和截图 overlay 的几何、焦点与关闭语义不同；统一业务管理会重新耦合。
- **每个 controller 各自继续复制隐身逻辑：** 舍弃。新增窗口会遗漏恢复、切换或清理路径，且策略行为容易漂移。
- **用全局事件总线广播窗口策略：** 舍弃。事件订阅和销毁关系难验证；同步注册表可直接枚举当前窗口并管理 listener。
- **让每个 renderer 页面拥有共享服务启停：** 舍弃。页面卸载与应用级资源生命周期不同，迟到清理可能关闭其他页面正在使用的服务。

## 后果与防回退

- 新建 `BrowserWindow` 必须通过 `registerWindowSurface` 登记角色和共享策略，并在显示前经过 `prepareWindowToShow`；`architecture:check` 对 main 进程中的每个 `new BrowserWindow(...)` 强制检查这两项接入标记。
- 增加 renderer 内部页面时优先使用页面路由，不新增 BrowserWindow；只有原生 surface 能力需求才新增窗口角色。
- 捕获保护、层级和非激活交互由同一 surface 描述登记，但分别执行、分别验证；不允许用 `showInactive()` 代替捕获保护。
- 注册表只释放自己拥有的 listener；各 controller 继续负责业务 listener 和资源 teardown。
- IME lease 仍是输入目标焦点、generation 和 composition 的唯一权威；surface registry 只发布 BrowserWindow 原生焦点事实。renderer crash 后业务状态恢复和全应用统一 dispose 编排不属于本阶段。

## 验证

- 自动化：`windowSurfaceRegistry.test.ts` 覆盖角色策略、捕获保护、原生焦点订阅、候选 owner attach/reconcile/解绑、策略失败 fail-closed、closed 清理和重复注册；IME IPC 测试覆盖共享原生 focus 流触发 lease suspend；selection/reply/candidate/capture controller 测试通过。
- 自动化：`pnpm --filter @answra/desktop typecheck`、desktop 全量 Vitest、`pnpm architecture:check` 通过。
- 完整门禁：`pnpm notes:check`、`pnpm verify`、`git diff --check` 通过；全仓 207 项测试通过。
- 实机：Windows 11 22631、Electron 29.4.6 的外部截图行为尚未复测；Electron API 状态不作为第三方捕获绝对保证。

## 风险

- BrowserWindow 的 `show` 事件发生时窗口已显示，所以敏感窗口必须由 `prepareWindowToShow` 包住显式显示调用，不能只依赖 `show` listener。
- 截图工具可能在失焦通知处理之前捕获；捕获保护行为仍需在目标系统和工具中实测。
- 静态架构门禁依赖源码中出现的注册和预检 API 标识；新增窗口的行为测试仍需要验证实际显示顺序。
