# Note：独立面试窗口

状态：提案

## 问题

面试首次引导和“面试分身”制作态目前渲染在主悬浮窗口的内容面板里：

1. 引导包含文件选择、文本输入、项目多选和可滚动表单，和主内容面板的“轻量浮层”定位不一致。
2. 第三步候选人档案海报会被面板高度压扁；虽然已用 `flex: 0 0 auto` 修复裁切，但继续复用面板仍是临时方案。
3. 用户明确要求面试入口改为独立浮窗；继续复用主面板会让面试与笔记本/设置共享 `content-panel--*` 的高度和生命周期。

本提案建议新增一个独立 Electron 窗口承载面试引导/制作态，不再占用主窗口的 `panel === "interview"`。核心不是另造一套窗口系统，而是把新窗口正常接入现有的窗口表面、隐身、截图和生命周期边界。

## 涉及范围

- 代码/模块：
  - `apps/desktop/src/main/interview/interviewWindowController.ts`：新窗口生命周期、尺寸、落位、显示/关闭
  - `apps/desktop/src/main/interview/interviewWindowIpc.ts`：打开/关闭/就绪 IPC
  - `apps/desktop/src/main/window.ts`：控制器组合、主窗口关闭、隐身与截图接线
  - `apps/desktop/src/main/windowSurfaceRegistry.ts`：新增 `interview` 窗口角色与置顶/焦点策略
  - `apps/desktop/src/main/interview/interviewOnboardingIpc.ts`：可信来源放宽到主窗口 + 面试窗口
  - `packages/shared/src/channels/interview.ts`、`packages/shared/src/bridge.ts`：窗口频道与桥方法
  - `apps/desktop/src/preload/index.ts`：只转发，不放业务逻辑
  - `apps/desktop/src/renderer/main.tsx`：新增 `?surface=interview` 路由
  - `packages/ui/src/interview/window/InterviewWindowApp.tsx`、`InterviewWindow.css`：独立窗口渲染器与拖拽/铺满布局
  - `packages/ui/src/app/FloatingBarApp.tsx`：面试入口改为打开独立窗口
  - `packages/ui/src/app/InterviewFeaturePanel.tsx`：继续复用引导/制作态内容，并保留浏览器预览/测试兜底
- UI/进程/协议/持久化表面：
  - 新增原生窗口角色和窗口 IPC；引导数据继续走现有 `interview:onboarding-*` 频道，不新增第二套状态源。
  - 不持久化简历/项目正文；不新增窗口位置持久化。
  - 主窗口仍只负责悬浮条和内容面板；面试窗口不参与 `content-panel--interview` 高度。
- 相关 Note：
  - [面试前引导与候选人档案首次使用流程](../feature/2026-11-11-interview-onboarding-and-avatar.md)
  - [窗口表面生命周期](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)
  - [主窗口与隐身边界](../../implemented/architecture/2026-10-11-main-window-and-stealth-boundaries.md)
  - [桌面窗口控制器边界](../../implemented/architecture/2026-10-11-desktop-window-controller-boundaries.md)
  - [Shell fit-content 与浮窗](../../implemented/architecture/2026-10-10-shell-fit-content-and-surfaces.md)
  - [声明式浮窗 P0](../../implemented/architecture/2026-11-11-declarative-surface-p0.md)
  - [Electron 捕获保护兼容性](../../implemented/bug-fix/2026-10-11-electron-capture-protection-compatibility.md)
  - [窗口标题 Answra](../../implemented/feature/2026-11-01-window-title-answra.md)

## 提案

### 1. 核心判断

独立窗口本身不是难点；难点是让现有隐身和窗口策略真正作用到它。只创建一个 `BrowserWindow` 而不注册角色，`applyStealth`、置顶、捕获保护都不会覆盖它。

因此方案是：**新窗口 + 复用现有 `registerWindowSurface` / `applyStealth` / capture 流程**，不新增第二套隐身机制。

### 2. 窗口形态

新增一个独立 `BrowserWindow`，角色名为 `interview`：

- `640×600` 初始内容尺寸，按主窗口所在显示器的工作区 clamp，窗口不可缩放。
- 无边框、透明、可拖动、`skipTaskbar: true`、`hasShadow: false`、`show: false`。
- 置顶层级使用 `floating`，与主窗口/回复条一致；只在用户主动打开时出现。
- 角色策略使用 `nonActivating: "never"`，因为引导需要输入和聚焦；隐身时直接关闭，不伪装成“可见但不可聚焦”。
- 顶部进度条/标题行作为拖拽区，按钮、输入框、文本域设置 `-webkit-app-region: no-drag`。
- 加载 `index.html?surface=interview`（开发态 `http://127.0.0.1:5180/?surface=interview`），标题仍为 `Answra`。

### 3. 隐身接入

这是本提案的关键接线，全部复用现有机制：

- 窗口创建后注册为 `interview` role，使 `windowSurfaceRegistry` 的置顶和捕获策略生效。
- `showInterviewWindow()` 先检查 `isStealthEnabled()`；隐身开启时返回 `{ opened: false }`，不创建/不显示窗口。
- `applyStealth(true)` 时主动关闭面试窗口；隐身关闭后不自动重开。
- 不把面试窗口加入 `nonActivating` 的隐身焦点策略；它的隐身语义是“不可见”，不是“可见但不可输入”。

### 4. 生命周期

- 主窗口关闭时关闭面试窗口，避免 `window-all-closed` 被残留窗口卡住。
- 原生关闭（Alt+F4 等）只销毁面试窗口，不影响主窗口。
- 区域截图开始时隐藏面试窗口，结束后按原可见状态恢复；不能把简历/项目内容留在截图里。
- 窗口渲染器挂载后发送 `interview:window-ready`，主进程收到后再显示，避免先出现空白窗口。
- 窗口位置不持久化；每次打开按主窗口所在显示器居中并 clamp 到工作区。后续如需记忆位置，再单独提案。

### 5. 状态与 IPC

- 面试引导的唯一事实来源仍是 `interviewOnboardingStore`；新窗口不复制状态、不缓存正文。
- 新窗口复用现有 `useInterviewOnboarding`、`InterviewOnboardingPanel`、`InterviewAvatarPanel`。
- 引导 IPC 的可信来源从“仅主窗口”放宽为“主窗口或面试窗口”；其他 sender 继续拒绝。
- 选择简历的文件对话框以实际调用窗口为 parent；renderer 仍不能传任意路径。
- 新增三个窗口频道：
  - `answra:interview:window-open`：主窗口 → main；返回 `{ opened: boolean }`。
  - `answra:interview:window-close`：面试窗口 → main；只接受面试窗口 sender。
  - `answra:interview:window-ready`：面试窗口 → main；只接受面试窗口 sender。
- `DesktopBridge` 增加 `openInterviewWindow`、`closeInterviewWindow`、`requestInterviewWindowReady` 三个可选方法；preload 只转发。

### 6. 主窗口入口

- 切换到面试模式或点击面试入口时调用 `openInterviewWindow()`；不再打开 `panel === "interview"`。
- 离开面试模式时调用 `closeInterviewWindow()`，保持“切换模式即收起面试界面”的旧行为。
- 浏览器预览/测试环境没有 `openInterviewWindow` 时，保留旧面板渲染作为兜底；生产桥存在时绝不打开旧面板。
- 主窗口的悬浮条、对话面板、笔记本高度不变；本次不调整 `PanelShell.css` 的 notes 变体。

### 7. 明确不做

- 不把引导改成 `SurfaceSpec`；现有声明式浮窗没有输入框、文件选择和多步表单。
- 不为每张卡片创建 BrowserWindow；整个面试流程只复用一个独立窗口。
- 不在应用启动时自动打开面试窗口。
- 不新增第二套 onboarding store，不把简历正文写入窗口位置、日志或审计。
- 不在本次顺手调矮笔记本；如果用户仍觉得 notes 面板过长，另开 notes 高度提案。
- 不做窗口位置持久化。

## 模块边界

- **main 控制器**：只负责 BrowserWindow 创建、显示、关闭、落位、截图隐藏、sender 判断；不读简历、不解析项目。
- **window.ts**：组合根，接线 controller、隐身、主窗口关闭和 capture；不复制面试业务状态。
- **onboarding IPC**：只做 sender/载荷校验和 store 调用；文件框 parent 由调用窗口决定。
- **renderer**：`InterviewWindowApp` 只负责窗口根布局、拖拽、主题和关闭转发；引导/制作态仍由现有 UI 组件渲染。
- **shared**：只放频道、请求/响应类型和桥接口；不引入 Electron/Node 依赖。
- **preload**：只转发频道，不判断隐身、不拼业务文案。

## 曾考虑的替代方案

- **继续留在主内容面板，只压缩文案和高度：** 舍弃。用户已明确要独立浮窗；继续压缩会让表单、项目列表和第三步海报反复拥挤。
- **同窗口内独立浮层，不新增 BrowserWindow：** 舍弃。它仍受主窗口尺寸和 fit-content 测量约束，无法真正解决“默认面板高度被面试影响”的问题。
- **复用声明式 `SurfaceSpec` 浮窗：** 舍弃。SurfaceSpec 没有输入框、文件选择和多步状态；扩展它会破坏现有浮窗系统的边界。
- **复用已关闭的独立回复窗口 controller：** 舍弃。回复窗口入口处于迁移期关闭状态，生命周期和主窗口隐藏/恢复语义不同。
- **新窗口复制一份 onboarding 状态：** 舍弃。会产生双写和 revision 冲突；现有 store 已是唯一事实来源。
- **窗口在隐身时保持可见但不可聚焦：** 舍弃。用户会看到可点击但输入失效的界面，违反隐身语义。
- **窗口位置持久化：** 首版不做。独立窗口位置不是当前问题，先减少存储面和恢复流程。

## 验收标准

- 可观察结果：
  - 切换到面试模式后，主窗口不出现面试面板，而是弹出独立面试窗口；笔记本面板高度不变。
  - 独立窗口可拖动、可关闭，引导三步、项目选择、目标岗位、跳过/完成/重新编辑行为与当前一致。
  - 隐身开启时打开面试入口不会出现窗口；面试窗口已打开时开启隐身会立即关闭。
  - 主窗口关闭时面试窗口一并关闭；截图时面试窗口不进入截图，结束后按原状态恢复。
  - 文件选择框以面试窗口为 parent，取消后状态不变。
- 自动化验证：
  - 新 controller 测试：角色注册、ready 握手、隐身拒绝、主窗口关闭、截图隐藏/恢复、sender 校验。
  - registry 测试：`interview` 角色置顶策略与焦点策略。
  - IPC 测试：主窗口才能 open；面试窗口才能 close/ready；非法 sender 被拒绝。
  - onboarding IPC 测试：主窗口和面试窗口均可读写；其他 sender 拒绝；文件框 parent 正确。
  - UI 测试：`InterviewWindowApp` 加载/引导/制作态/关闭/ready；主窗口入口调用 `openInterviewWindow`；无桥时保留面板兜底。
  - `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/desktop typecheck`、相关 vitest、Biome、`tokens:check`、`notes:check`。
- 需要的实机验证：
  - Windows 11 下窗口聚焦、拖动、文件对话框、Alt+Tab/任务栏行为。
  - 隐身开启/关闭时的拒绝与关闭行为。
  - 多显示器下落位与工作区 clamp。
  - 区域截图时窗口隐藏/恢复，简历内容不进入截图。
  - 打包态下窗口加载路径与 `Answra` 标题。

## 风险

- **隐身时序：** 主窗口的 stealth 设置由 renderer 异步上报；如果面试窗口在配置完成前打开，可能出现短暂焦点异常。`show()` 必须先检查 `isStealthEnabled()`，`applyStealth(true)` 时主动关闭。
- **截图泄漏：** 仅依赖 `captureProtection` 不足以覆盖所有截图路径；必须把面试窗口加入区域截图的隐藏/恢复流程。
- **应用生命周期：** 面试窗口未关闭会导致 `window-all-closed` 不触发、主窗口无法重建；必须在主窗口 `closed` 时销毁。
- **打包态可用性：** 当前 preload 用 `interviewAvailable: !isPackaged` 禁用打包态面试入口；如果独立窗口要在打包态使用，需要单独拆分“面试窗口可用”和“本地 ASR 可用”两个开关。
- **窗口尺寸：** 640×600 在小屏/高缩放下可能被工作区 clamp；卡片必须继续使用内部滚动，不能依赖固定高度裁切。
- **决策冲突：** 现有 onboarding Note 明确写着“不新增独立原生向导窗口”和“暂缓新窗口”；本提案是对该决定的重新评估，评审通过后需要同步更新旧 Note。

## 当前工作区状态

本 Note 是提案，不代表已实施。上一轮未完成的窗口接线改动已回退；当前工作区只保留第三步海报滚动修复和本提案文档。评审通过后再开始实现。
