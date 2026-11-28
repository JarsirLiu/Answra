# Note：内嵌浏览器浮窗面板（用户与 Agent 共操作）

状态：提案

## 问题

Answra 目前没有浏览器能力：桌面只有自己的 Electron 窗口（主浮窗、回复条、surface、截图框选），渲染页加载本地 renderer；`WebFetch` 只是 agent 进程里的 HTTP 请求，`WebSearch` 只返回搜索结果。用户希望有一个**独立的浏览器浮窗面板**，与对话面板并排：用户能像普通浏览器一样在里面浏览、登录、操作；AI 也能在同一个页面上读快照、点击、填写并执行受控命令。

动手前必须定下载体、登录态来源、双方操作的所有权和安全边界。参考的三个仓库给出的是三种不同答案：opencode 用内嵌 Chromium + `webContents.debugger`；codex 用 MV3 扩展 + native messaging + browser-use 策略；ZCode 用 Electron 44 + `<webview>` guest + CDP + Playwright，并导入真实 Chrome cookie。我们不能因此升级 Electron——桌面锁定 **35.0.0**，升级会重开已实测的捕获保护矩阵。

本 Note 只定方案和边界，不改代码；实施前必须评审通过。

## 涉及范围

- 代码/模块：
  - 新增 `apps/desktop/src/main/browser/`：`browserWindowController.ts`、`browserSession.ts`、`browserCdp.ts`、`browserTabState.ts`、`browserCommandRouter.ts`、`browserPermissionPolicy.ts`。
  - `apps/desktop/src/main/windowSurfaceRegistry.ts`：新增 `WindowRole = "browser"` 及其策略；不改现有四类窗口。
  - `apps/desktop/src/main/ipc/`：按领域新增 browser handler，复用 `isWindowFromSender` 校验。
  - `packages/shared/src/channels/browser.ts`：频道常量与请求/响应映射；`packages/shared/src/channels.ts` 聚合。
  - `packages/shared/src/schema/events.ts`：浏览器动作的事件 payload（工具调用/结果沿用现有 envelope，不新增事件体系）。
  - `apps/agent/src/core/tool/`：声明受控 browser 工具的 schema 与端口；实际执行留在 desktop。
  - `apps/desktop/src/renderer`、`packages/ui/src/components/tool-call/`：面板工具栏与浏览器工具调用投影。
  - `apps/desktop/src/preload/`：只在 `window.answra` 上转发受限 API，不放业务逻辑。
- UI/进程/协议/持久化表面：独立 `BrowserWindow` + `WebContentsView`；独立 Electron partition；有限 IPC 命令；工具事件进入既有 transcript/tool-call 投影；不改 Session/Turn/Step 语义。
- 相关 Note：
  - [原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)
  - [会议场景隐身模式的窗口与捕获边界](../architecture/2026-10-13-comprehensive-stealth-mode.md)
  - [Agent 工具系统基础](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)
  - [工具调用 UI 架构](../../implemented/architecture/2026-11-09-tool-call-ui-architecture.md)
  - [coding 免密钥网页搜索与抓取](../../implemented/feature/2026-11-28-coding-web-search-and-fetch.md)

## 影响表面

- **窗口：** 新增第五类原生窗口，语义是「用户可交互的普通窗口」——可聚焦、可缩放、不透明；不与 `main` / `reply-bar` / `surface` 共用无边框透明浮层策略，也不因隐身开启变成不可聚焦。
- **用户行为：** 用户可在面板中导航、登录、刷新、开/关标签页、正常输入；AI 操作期间显示明确的活动标记；AI 创建的标签页放进独立标签组，便于识别和清理。
- **Agent 行为：** 获得一组受控浏览器命令（见提案），结果以既有工具调用/结果进入对话；不再只有 HTTP 抓取的「无页面上下文」能力。
- **登录态：** 面板使用自己的持久化 partition，用户需要在面板里登录一次；**不会自动继承用户 Chrome 的登录态**，也不导入其 cookie。
- **不触及：** 不新增 CLI 浏览器工具、不新增移动端浏览器能力、不改 WebSearch/WebFetch 的现有语义。

## 模块边界

- `desktop/main` 是浏览器会话、标签页、WebContentsView 与 CDP 绑定的**唯一所有者**：创建/销毁、attach/detach、导航、截图、权限决策都在这里。
- `apps/agent` 只声明工具 schema 与窄端口，执行时把命令发给 host；不 import Electron/Node，不直接持有 `webContents`，不复制窗口状态。
- `packages/shared` 只放通道常量、DTO 与事件 payload；不放 Electron 类型或执行逻辑。
- renderer 只画工具栏、标签条和活动标记；不解析页面内容、不判断 Agent 事件语义、不代执行工具。
- 不建立通用插件/DI 框架，不引入独立 Node sidecar；不让 desktop 通过反向 RPC 代执行 Agent 领域工具（浏览器本身就是 desktop 平台能力）。

## 提案

### 1. 载体选择

用**独立 `BrowserWindow` + `WebContentsView`**，不用 `<webview>`、不用 `BrowserView`：

- `WebContentsView` 从 Electron 30 起提供，`contentView.addChildView()` 在 35 可用；`BrowserView` 已废弃，`<webview>` 的 guest 生命周期是 ZCode 崩溃事故的来源。
- 窗口顶部预留一条 toolbar 高度（React renderer DOM：地址栏、前进/后退/刷新、标签条）；下方 `WebContentsView.setBounds()` 占据剩余区域。原生 view 不能被 DOM 覆盖，所以必须预留区域而不是做浮层。
- 一个标签页对应一个 `WebContentsView`；只把 active tab 挂载到 `contentView`，其他 detach 但保留 `webContents` 与页面状态。窗口 resize 时同步 `setBounds`。
- `setWindowOpenHandler` 把 `target=_blank` 纳入本面板的新标签页，不弹出独立浏览器窗口。
- 分区使用 `session.fromPartition("persist:answra-browser")`，与 app 自身 renderer 的 session 隔离，cookie/localStorage 跨重启保留。

### 2. 命令面（首版）

只开放可审计、可串行、可确认的有限命令：

```text
tabs.list / tabs.open / tabs.close / tabs.select
navigate / back / forward / reload
snapshot                 # DOM + 元素 ref，只读
click / fill             # 按 tabID + ref 操作，需确认
evaluate                 # 有界表达式，默认拒绝，显式授权后开启
screenshot               # 当前 viewport，非 fullPage
wait                     # 有界等待某元素或 URL
```

每条命令的输入都是 schema 校验过的 DTO；输出走既有 tool-call 结果与 envelope。模型不能直接传任意 CDP 方法、任意脚本或任意文件路径。

### 3. 双方操作与生命周期所有权

ZCode 的事故根因是「guest 销毁时 CDP 绑定还挂着，detach 清理抛 `Object has been destroyed`，rebind 引发 browser 主进程崩溃」。我们以简化设计规避：

- 每个 tab 同一时刻只允许一个 attach/rebind flight；`Object has been destroyed` 必须 catch、清引用，不允许盲目 rebind。
- 已附着或被 Agent 认领的 tab 不做 in-place 导航；需要导航则先 detach，再 loadURL。
- 用户关闭一个 Agent 碰过的 tab 是正常生命周期事件，不是异常；宿主统一收敛状态。
- 每个 tab 一个串行命令队列；Agent 命令与用户原生输入并存时不互相抢占 CDP 连接。UI 显示「Agent 正在操作」，用户可中断；中断只停止后续命令，**不证明已发出的动作没发生**，重复点击/提交前必须先查页面状态。
- 简化的 tab residency：`active / background / suspended`，首版上限 8；可见、操作在途、捕获在途、媒体播放、加载中的 tab 受保护，不被自动回收。

### 4. 权限与风险控制

- 默认拒绝：Agent 的导航与交互按 origin 白名单授权；没有显式允许的 origin 不操作。
- 高风险动作（登录、提交表单、授权/权限变更、私密数据外发）要用户确认；授权生命周期按 turn/thread，不做无限期静默批准。
- Electron partition 注册 permission handler：无害权限静默白名单（如剪贴板写、fullscreen、pointerLock、mediaKeySystem），敏感权限弹窗 + per-origin 持久化，设备类权限不得静默授权首个设备，其余 fail-closed。
- 页面文本一律是数据，不是指令；schema 校验不赋予页面内容任何权限。不得用 OS 自动化或另一条工具链绕过浏览器侧的拒绝。
- `evaluate` 默认关闭；开启后限制执行时长、输出字节和可用 API，且仍受 origin 授权约束。
- 浏览器 partition 数据属于本地敏感数据，只落在 app data 目录；不进入 `@answra/config`，不进日志、事件文本或模型 structured output。

### 5. 不做什么

- 不导入 Chrome cookie/localStorage，不解密其他浏览器的凭据。
- 不控制用户真实 Chrome；MV3 扩展 + native messaging 另立 Note。
- 不加 Playwright 依赖、不做 DOM locator/自愈栈、不做 WebM 录制、不做透明窗口截图 bootstrap。
- 不升级 Electron；若将来确有 API 需要 35 以上版本，另立 Note 并重跑捕获保护验证。

## 曾考虑的替代方案

- **MV3 扩展 + Native Messaging（Codex 路线）：** 能直接操作用户已登录的真实 Chrome，保留所有站点权限；但产品形态是「控制用户的浏览器」，不是「我们自己的浏览器面板」，需要用户安装扩展并注册 native host。保留为后续独立 Note，本次舍弃。
- **导入 Chrome cookie/localStorage 到内嵌分区（ZCode 路线）：** 能复用登录态，但要读取并解密另一款浏览器的凭据（Windows App-Bound key / macOS keychain / Linux helper），与仓库的凭据边界冲突，且容易被 Chrome 更新打断。舍弃。
- **`<webview>` guest + CDP（ZCode 实现）：** 对 renderer 驱动的标签条友好，但 guest 的 claim/release/rebind 生命周期复杂，已造成 browser 主进程原生崩溃。我们用 `WebContentsView` 把所有权收归 main，舍弃。
- **CDP 直连用户默认 Chrome profile：** Chrome 136+ 禁止对默认 profile 使用 `--remote-debugging-port`；只能得到无登录态的独立 profile，等于没有解决问题。舍弃。
- **OS 层 UI 自动化（Codex computer-use）：** 能操作任意应用，但没有 DOM 语义、脆弱且慢，不适合作为浏览器面板的主通道。只作为非浏览器应用的兜底，本次不做。
- **升级到 Electron 44：** ZCode 用 44，但我们所需 API（`WebContentsView`、partition、debugger、权限 handler）在 35 已全部具备；升级还会触发已实测的捕获保护重验。舍弃。

## 验收标准

- 可观察结果：
  - 用户在浮窗面板中能正常浏览、登录、刷新、开/关标签页，输入焦点与中文 IME 正常。
  - Agent 能在同一面板里执行 `navigate/snapshot/click/fill`，对话中能看到工具调用与结果；页面变化实时发生在用户可见的标签页上。
  - Agent 操作期间有可见标记；用户关闭被 Agent 碰过的标签页不会导致应用崩溃。
  - 隐身开启/关闭时窗口行为符合窗口策略注册表的声明，不出现「用户点不动」或「隐藏后仍被捕获」。
- 自动化验证：
  - tab residency 状态机、单 flight attach、destroyed 异常处理、命令串行队列的单元测试。
  - 权限策略的 default-deny、per-origin 持久化、静默白名单与设备权限不静默授权测试。
  - shared 通道 DTO/事件 schema 的类型检查；browser 窗口注册与显示前预检的架构测试。
  - `packages/ui` 的工具调用渲染与面板工具栏契约测试。
- 需要的实机验证：
  - Windows 11 + Electron 35.0.0：真实登录流程、Agent 点击/填写、操作中关闭标签、多显示器、隐身切换、截图/共享场景下捕获保护行为。
  - 中文 IME 在地址栏、页面输入框和 Agent 填写后的候选窗表现。

## 风险

- `WebContentsView` 是原生层，DOM 覆盖与圆角/透明窗口的视觉效果需要实测；首版采用不透明窗口降低风险。
- CDP 生命周期竞态仍是最大风险：必须靠单 flight、导航前 detach、destroyed catch 与宿主唯一所有权控制；不能用重试掩盖。
- 用户需要重新登录一次，这是「不导入 Chrome cookie」的有意代价；必须在 UI 上说明，避免用户误以为继承了登录态。
- 页面内容不可信，可能出现提示词注入；高风险动作必须保留用户确认，不因「任务看起来合理」自动放行。
- partition 持久化 cookie 是敏感数据：要提供清除数据入口，且不进入日志/事件/模型输出。
- 首版 tab 上限与 suspended 简化可能不够用；若后续放宽，必须另立 Note 说明保护状态与恢复顺序。
