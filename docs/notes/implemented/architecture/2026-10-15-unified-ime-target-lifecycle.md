# Note：统一 IME 输入目标与窗口生命周期

状态：已实施

## 问题

应用主窗口与回复窗口共用一个 main 进程 Rime session，但 renderer 输入控件各自观察 DOM 焦点、维护候选锚点并调用 IPC。owner、target、焦点和候选状态之间没有 generation 契约，异步按键响应、React cleanup 或旧候选清理可能作用于后来取得焦点的输入目标。输入法原先只接入对话 composer，设置和工作区文本编辑体验不一致。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeIpc.ts`、`imeSessionState.ts`、`imeCandidateIpc.ts`、`imeCandidateWindowController.ts`、shared/preload IME bridge、`packages/ui/src/ime/imeInputTargetCoordinator.ts`、`useEmbeddedIme.ts`、编辑器 adapters 和 UI 控件。
- UI/进程/协议/隐私表面：main/reply renderer 共享 Rime owner lease；登记文本目标的焦点、输入、提交、selection 与候选锚点；候选原生窗口及捕获保护；敏感和专用控件排除策略。
- 相关 Note：[内置 Rime 输入法桥接](./2026-10-14-embedded-rime-ime.md)、[IME 候选条使用独立原生窗口](../feature/2026-10-14-ime-candidate-native-window.md)、[恢复 Rime 只读输入与对话光标](../bug-fix/2026-10-15-ime-readonly-composer-and-caret.md)。

## 根因

- main 的共享 Rime session 没有 owner token/generation；renderer cleanup 可以与其他输入目标的生命周期竞争。
- DOM editor focus、BrowserWindow 原生 focus、session ownership 和候选锚点是不同状态，但此前没有显式的 lease 和 focus confirmation。
- candidate update/clear/action 不绑定目标与 generation，迟到消息无法与当前候选身份区分。
- 可编辑控件没有统一的接入边界，通用 input 操作也不能正确处理 CodeMirror selection。
- renderer 的 Acquire 是异步 IPC；首焦点后的快速按键可能早于 lease generation 和 enabled 状态到达，被误交给系统输入链路；重新打开面板时 Acquire 已完成，因此症状会消失。

## 决定

main 持有唯一 Rime session lease；每次输入目标切换取得新 generation。main 串行处理 acquire/release/focus confirmation/key/select/reset，并验证 BrowserWindow sender、target 与 generation。窗口原生 blur 暂停 lease 并隐藏候选，不清除 composition；恢复后必须由当前 renderer 再确认 editor focus，之后才允许键盘和候选更新。

每个 renderer 使用单一 `imeInputTargetCoordinator` 维护当前 target。控件显式声明 `data-ime-policy="text"` 或 `data-ime-policy="excluded"`，只有登记的自由文本目标可以申请 lease。各编辑器保留自己的 adapter：input/textarea 使用 selection range；CodeMirror 使用 `EditorView` selection、`replaceSelection` 和 content DOM caret 几何。内置 IME 接管期间 input/textarea 保持原生 `readOnly` 以隔离系统 IME；renderer 根据真实 selection 和文本布局绘制应用内 caret，Rime commit 由 adapter 更新受控值。候选更新、清理、暂停和 action 均携带 target/generation；candidate controller 仅接受与当前候选 identity 匹配的清理消息。

## 修复

- 将旧 enable/disable 协议替换为 typed `Acquire`、`Release`、`ConfirmFocus` lease 协议；key/select/reset 附带 generation。main 对 Rime 操作串行化，renderer reload/crash/window close 撤销对应 lease。
- 加入纯状态 reducer，明确 `idle`、`owned`、`suspended`、`unavailable`、`disposed` 状态迁移。
- renderer coordinator 在本窗口切换 target 时先使旧 target 失效；输入队列在发送前和应用响应前二次核对 target lease，避免释放后的排队请求及旧响应继续改变输入。
- 已聚焦目标在首次 Acquire 完成前收到的按键先由 IME adapter 消费，并进入同一串行输入队列；队列等待 Acquire 后取得 generation 再发送，避免首次输入绕过 Rime。目标失焦、释放或切换时仍按 generation/active-target 检查丢弃旧请求。
- 修复主对话和回复 composer 的 target ID 与 acquire 请求不一致问题；候选 UI 只接受当前 lease 的 target/generation。
- 接入对话 composer、设置 URL/模型名、工作区目录筛选和 Markdown CodeMirror 源码编辑器。API Key（包括明文显示）、文件、checkbox、range、emoji 搜索及未适配的 TipTap editor 明确排除。
- 所有内置 IME 适配器必须标记 `data-embedded-ime-target`，以便隐身焦点守卫仅放行由应用管理组合输入的控件；敏感字段不加此标记。
- CodeMirror 活跃且没有 Rime 组合时，Enter 由 adapter 显式派发换行 transaction；组合中的 Enter 交给 Rime，未组合 Backspace 和系统快捷键保留 CodeMirror 原行为。不能依赖 `beforeinput` 撤销 CodeMirror keydown 默认事务。
- 隐身策略仍由窗口策略 registry 在候选窗口展示前应用；OS capture exclusion 是平台尽力能力，不构成所有第三方截图路径的保证。

## 曾考虑的替代方案

- **让每个 renderer 自行启停全局 Rime：** 舍弃。共享 session 由 main 独占；局部组件不能拥有全局引擎生命周期。
- **DOM 自动发现并接管所有可编辑节点：** 舍弃。会误接管 password/API Key、file、专用数值控件和没有 selection adapter 的编辑器；文本目标必须显式登记。
- **为 CodeMirror 复用 input 的 `setRangeText`：** 舍弃。CodeMirror 由 `EditorView` transaction 管理 document/selection，直接修改 DOM 会脱离其状态模型。
- **原生 blur 时释放并重建 session：** 舍弃。外部截图和应用切换会丢失未提交 composition；blur 只暂停输入/展示，owner 切换才清理 composition。

## 模块边界

- `imeSessionState.ts`：定义 owner lease 的纯状态转移，不执行 IPC 或 Rime 操作。
- `imeIpc.ts`：在 main 内串行持有 `RimeBridge`，校验 sender/target/generation，并绑定 BrowserWindow 与 WebContents 生命周期。
- `imeInputTargetCoordinator.ts`：每个 renderer module instance 只允许一个活动 target；target hook 只在焦点、候选与输入事件上调用 coordinator。
- `useEmbeddedIme.ts`：负责当前 target lease、本地按键队列和 commit callback，不拥有跨窗口 session。
- input/textarea、CodeMirror 分别使用各自编辑模型处理 selection、commit 和 caret；`ImeCandidateAnchorReporter` 仅发布当前目标的屏幕锚点。
- `imeCandidateIpc.ts` 与 candidate window controller：校验当前 lease 和候选身份，管理原生候选窗口及其几何位置。
- shared channels/preload：定义 acquire/release/focus confirmation 和候选状态载荷；preload 只转发，不持有编辑业务状态。

## 后果与防回退

- 同一时刻只有一个 renderer owner 和一个 renderer 内活动 target。跨窗口或同窗口 target 切换会使旧 generation 失效，未提交 composition 被清空，避免拼音写进错误草稿。
- 普通文本目标共享统一生命周期，但 adapter 仍需逐种验证 selection、commit、caret 和锚点；没有 adapter 的编辑器必须保持 `excluded`。IME input/textarea 继续使用 `readOnly`；若 Chromium 不绘制其原生 caret，必须以应用内 caret 覆盖显示，不能为显示光标而恢复系统 IME 可接管的可编辑状态。
- 可用目标为：对话/回复 textarea、设置 URL/模型输入、工作区目录筛选和 CodeMirror Markdown 源码。TipTap `RichTextComposer` 当前没有接入并标记 excluded；不能称为已支持。
- `data-ime-policy` 是输入边界的一部分。新增或更改输入控件时必须标 `text` 或 `excluded`，敏感字段即使显示为 text 也必须 excluded。
- Candidate clear/suspend 需要当前 targetId 和 generation；不可移除 controller 与 IPC 的身份核对。
- renderer 只可释放自己取得的 generation；不得重新加入不带 owner identity 的全局 disable IPC。
- 首次焦点后立刻输入必须在 Acquire pending 状态下拦截并排队；不能用 `state.enabled` 尚未更新作为放行按键到系统输入链路的理由。
- renderer 与 main 生命周期诊断不得记录按键文本、preedit、候选词或草稿内容。

## 验证

- 自动化：lease 状态 reducer、跨主/回复窗口 owner 竞争、stale owner 操作拒绝、候选 IPC 身份校验、候选 controller stale clear 拒绝、renderer 单活动 target、首次 Acquire pending 按键排队、释放后的 queued key 作废、textarea 锚点，以及 CodeMirror 选区提交、Enter 换行和未组合 Backspace 均有测试。
- 已通过：`pnpm verify`（Biome、Note 检查、全包 typecheck、UI 117 tests、desktop 106 tests、app 7 tests、architecture check）；`git diff --check`。
- Windows 实机：需要用户启动应用验证主窗口/回复窗口切换、系统 IME 不接管、候选窗焦点恢复、CodeMirror 中英文和选区替换，以及隐身状态下候选窗截图表现。自动化测试不能证明 Electron/Windows native focus 时序或第三方采集工具遵守 capture exclusion。
