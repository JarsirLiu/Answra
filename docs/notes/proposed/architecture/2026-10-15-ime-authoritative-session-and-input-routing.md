# Note：内置输入法权威会话状态与文本路由

状态：提案

## 问题

当前输入法把 Rime 引擎状态、输入框焦点、文本编辑和候选窗口展示拼在同一条 renderer hook 链路中。Rime session 在 main 进程共享，但 `asciiMode` 在每个 `useEmbeddedIme` 实例中独立维护；renderer 按 Shift 立即翻转本地模式，IPC 的 `ImeState` 又不返回 Rime 当前模式。UI 因此可能放开英文输入，但引擎仍在中文模式，或在切换输入框后重置成中文。

输入框再按 `active && !asciiMode` 推导 `readOnly`、`onChange` 和按键路由。模式、焦点与可编辑性由多个组件重复判断。Shift 在组合期间还会先 reset，再请求 Rime 切换，造成未提交拼音直接消失。数字在无组合和有组合时走两条不同路径，但缺少按物理按键验证“恰好处理一次”的端到端测试；用户已报告出现重复数字，当前诊断不足以区分重复事件、Rime 提交与 renderer 插入。

这使每个输入框都必须理解引擎模式、候选组合和 lease 生命周期，导致对话、回复、设置、工作区等输入体验分叉，也让团队并行开发容易重复实现状态判断。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/shared/src/bridge.ts`、`apps/desktop/src/main/ime/imeIpc.ts`、`imeSessionState.ts`、`rimeBridge.ts`、`apps/desktop/native/rime-host/`、`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/ime/`、所有文本输入 adapter、候选窗 controller 和 `windowSurfaceRegistry.ts`。
- UI/进程/协议/隐私表面：主/回复窗口共享 Rime session；对话、设置与工作区文本目标；键盘事件、文本提交和选区；候选窗锚点、可见性及捕获保护；Windows/macOS 系统 IME 隔离。
- 相关 Note：[统一 IME 输入目标与窗口生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)、[内置 Rime Shift 中英文切换](../../implemented/feature/2026-10-15-ime-shift-language-toggle.md)、[恢复 Rime 只读输入与对话光标](../../implemented/bug-fix/2026-10-15-ime-readonly-composer-and-caret.md)、[窗口表面状态管理](../../implemented/architecture/2026-10-15-window-surface-state-management.md)。本提案补充并替代现有 Shift Note 中“每个 hook 乐观维护模式”和“组合中先清空再切换”的决定；实施时必须同步修订这些 Note，不能保留相互冲突的已实施说明。

## 提案

本提案先冻结状态所有权与转移契约，再分阶段迁移实现。第一阶段只建立可审查的 shared 命令/snapshot 契约和 main session 管理边界，不同时改写编辑器、候选窗和平台系统 IME 隔离。以 main 进程的 `ImeSessionManager` 作为唯一输入法引擎会话状态所有者；每个状态域只有一个写入者，跨进程通过 typed snapshot 与命令结果传播，不允许 renderer 反推 Rime 状态。

状态所有权拆成四个域，彼此不得隐式改写：

- **引擎会话**：main 独占 Rime 生命周期及权威引擎状态，包括输入模式、composition 和候选。新应用会话默认中文；输入目标 acquire/release 不得切换模式。Shift 仅在引擎确认后更新权威模式。
- **输入目标 lease**：main 校验当前 window、webContents、target 与 generation；lease 只决定哪个目标能向引擎发命令，不拥有语言模式。任一时刻最多一个活动目标。
- **文本编辑**：renderer 的 editor adapter 拥有选区、光标和文本替换；key router 为每个事件选择唯一处理路径，不允许引擎 commit 与浏览器默认输入重复写入。
- **候选与窗口策略**：候选展示、锚点、原生焦点和捕获保护消费当前 owner/snapshot，不得 reset composition、切换模式或编辑文本。

目标转移规则：

- acquire 新目标时，若旧目标有未提交 composition，先显式取消旧 composition，再切换 owner；绝不把旧 composition 提交给新目标。输入模式保持不变。
- 当前应用窗口暂时失焦时，将 lease 标记为 suspended，暂停接收按键并隐藏候选；composition 与模式留在 main session，仍属于原 target。恢复时必须重新确认同一 owner 和 DOM target 后才能继续输入。
- 原 target 卸载、所属 renderer 导航/reload/crash 或窗口关闭时，撤销 lease 并取消其 composition；不能将 composition 留给后续 target。

Shift 只表达中文/ASCII 模式切换，不作为 Rime 按键，不参与候选、composition 或编辑状态。renderer 将 Shift 排入输入命令队列；轮到执行时，依据最近收到的 main 权威快照生成明确的目标模式，再发送 `setInputMode`。这样快速连续 Shift 会按队列顺序反转已确认模式，不会因前一条命令尚未返回而重复请求同一模式。main 串行调用 helper `set-mode`，helper 用 `set_option("ascii_mode", ...)` 切换并用 `get_option` 回报实际模式。切换不得调用 reset、提交文本或清空/改写 composition；切换前后的 preedit、候选和选中位置应保持不变。左右 Shift 的 keydown 只触发一次模式命令，keyup 只消费按键，不发送给引擎。UI 只有收到匹配 generation/commandId 且模式匹配的成功响应后才更新文本路由。

本阶段明确不改变系统 IME 隔离机制，也不移除输入控件现有 `readOnly`/平台隔离行为。系统 IME 隔离与输入模式、编辑器可写性解耦，但实际替换隔离能力必须另立平台验证决策；Windows/macOS 未分别验证前，不得以当前架构重构为由重新开放系统 IME。

定义单一 `ImeSessionSnapshot`，至少包括：

- `phase`：`idle | owned | suspended | unavailable | disposed`。
- `owner`：window/webContents、targetId 和 generation。
- `engine`：启用状态、权威 `inputMode`、composition/preedit、候选和选择状态。
- `revision`：每次引擎状态变化递增，用于拒绝迟到结果。

定义命令及结果：

- `acquireTarget`、`releaseTarget`、`suspend`、`resume` 管理 owner lease，不修改输入模式，除非显式执行会话结束。
- `processKey` 接收目标、generation、物理 key/code、修饰键、keydown/keyup 与唯一 commandId；结果返回 `accepted`、`consumed`、权威 snapshot 和可选引擎 commit。
- `setInputMode` 表达目标模式，避免 renderer 和 Rime 各自独立 toggle；Shift 映射到“设为当前模式的相反值”命令，并通过 session 队列串行执行。
- `cancelComposition`、`selectCandidate` 是显式编辑命令，不由候选窗显示/隐藏或 input `blur` 隐式触发。
- 引擎 commit 带 commandId/revision，只能应用一次；renderer 对重复结果按标识去重。

引擎模式、输入编辑、候选展示和隐私策略是相邻但独立的状态域：

- **Rime engine adapter**：唯一包装 native helper 协议；提供真实模式查询/设置、key processing 和 commit。helper 协议 v2 增加启动版本握手、状态 `inputMode` 与 `set-mode` 命令；旧协议必须 fail closed。helper 协议版本、原生二进制、schema 与固定 SHA-256 资源必须一起发布。不得只改 C++ 源码就声称 `pnpm dev` 已验证；遵守仓库预编译资源约定。
- **Main `ImeSessionManager`**：唯一持有 session snapshot、owner/generation、command queue 和状态转移；校验 sender 与迟到结果；不读 DOM，不操作草稿。
- **Renderer `ImeInputCoordinator`**：订阅 snapshot，维护当前 renderer 内活动 target，调用 typed bridge；不维护第二份 `asciiMode`，不在组件里排队或 reset 引擎。
- **Editor adapters**：textarea/input 与 CodeMirror 分别负责 selection、caret、文本替换和 undo/redo；通过统一接口报告焦点/选区并应用一次性 `insertText`/engine commit。不知道候选窗层级或捕获保护细节。
- **Key router**：唯一按键策略入口，返回明确路由结果 `engine-consumed | editor-inserted | browser-shortcut | ignored`。活动 composition 中的数字是 Rime 候选键；无 composition 的数字只走一次 editor insertion；ASCII 文本只走 editor 原生文本事件。每种路由明确是否调用 `preventDefault`，不能同时调用 Rime commit 和 DOM 默认插入。
- **Caret/anchor reporter**：只测量当前 target 的 DOM selection 和屏幕几何；视觉 caret 不决定输入模式，也不写入草稿。
- **Candidate presentation controller**：候选窗口只订阅 engine composition、当前 owner 和有效锚点；显示/隐藏是 presentation 状态，不能 reset 或切换语言模式。
- **Window surface/privacy controller**：负责窗口层级、non-activating、原生焦点和捕获保护；只通知 session suspend/resume，不直接修改 editor 或 Rime composition。
- **Text input policy**：纯策略只根据当前目标 lease、main 权威输入模式和 composition 决定文本事件路径：lease 正在接管且中文模式时，字符由 Rime 处理并阻止 native 文本写入；ASCII 模式或目标未被 lease 接管时，文本由编辑器处理；系统 composition 只在目标 lease 接管期间由该目标拦截。退格在组合期间交给 Rime，否则回到编辑器 adapter。现有 `readOnly` 仍是 Windows 系统 IME 隔离的一部分，不能随策略抽取而移除；平台级 native 隔离与 renderer 的目标级事件策略各自独立，Windows/macOS 的替换隔离能力留待单独验证。模式切换不得重新启用系统 IME。

输入模式策略与 IME 开关分开：全局功能设置决定是否接管受支持的文本目标；每次 target lease 决定按键当前交给哪个 owner；引擎 `inputMode` 决定中文组合或 ASCII 文本路径；窗口隐私策略决定候选与编辑窗口是否受保护；平台隔离能力决定系统 IME 是否可介入。不得复用一个 `active` 布尔值表示这些含义。

第一阶段交付顺序（shared 模式命令与 Rime helper v2 握手、lease 生命周期解耦、main session manager 抽取、typed session command IPC、revisioned snapshot 查询/推送、`useEmbeddedIme` typed API 迁移、纯 key route 判定、受控文本范围编辑事务、CodeMirror 插入 adapter、候选 IPC 仅接收锚点并从 main session 投影 engine state、候选 renderer 消费 main snapshot，以及三个编辑器入口共用的纯文本事件策略）已在当前工作区实现；平台级系统 IME 隔离替换不属于本阶段且未获实机验证：

1. 冻结 shared snapshot/command/result 与状态转移规则，标明字段权威来源和 stale command 拒绝条件。
2. 在 main 建立 `ImeSessionManager`，集中 owner/generation、模式、composition、命令队列和 revisioned snapshot；已完成。`imeIpc.ts` 同时提供兼容旧接口和 typed command 入口，preload 可查询并订阅 main snapshot。
3. 增加 session reducer 与 IPC 契约测试，证明 acquire/release/suspend/resume 不意外修改输入模式，目标切换与销毁按上述 composition 规则处理。
4. `useEmbeddedIme` 已订阅权威快照并使用 typed session command；纯 `resolveImeKeyRoute` 已从 hook 抽出，受控文本范围编辑由 `controlledTextAdapter` 统一计算，CodeMirror 文本提交经 `codeMirrorTextAdapter` 进入自身 transaction/history。候选 IPC 只接收锚点与 owner 身份，main 校验 lease 后从 `ImeSessionManager` 投影 engine state；renderer 不能提交 engine state。候选 renderer 只消费 main 发布的快照。受控 input/textarea 与 CodeMirror 的 native text、composition 和 backspace 决策已收敛到 `imeTextPolicy`，迁移时保留现有 Windows 系统 IME 隔离及 `readOnly` 行为，不代表平台隔离替换已经完成。

## 当前实施状态

本次分支完成了架构第一阶段和文本事件策略迁移，自动化门禁全部通过。已完成内容如下：

- main 进程通过 `ImeSessionManager` 持有输入模式、composition、候选和 owner/generation/revision；target lease 不再决定语言模式。
- shared/preload/renderer 使用 typed session snapshot 和 command/result；迟到的 generation、revision 和 commandId 结果不能改写当前状态。
- Shift 只发送明确的 `setInputMode` 命令，renderer 不再本地乐观翻转模式，也不把 Shift 作为 Rime 普通按键。
- 候选窗口只提交 target、generation 和屏幕锚点，展示数据由 main 从权威 session 投影；候选显示/隐藏不再 reset composition 或切换模式。
- input/textarea 与 CodeMirror 通过同一 `imeTextPolicy`、key router 和 editor adapter 决定 native text、Rime、composition、backspace 和 preventDefault 路径；每个事件只有一条写入路径。
- Chat、Reply、Markdown editor 等入口已迁移到统一策略，并补充了 session、IPC、候选、key router、adapter、文本策略和组件回归测试。

尚未完成的内容不是 renderer 架构拼补，而是独立的平台验证和资源交付工作：

- Windows 11 与 macOS 的真实输入法、窗口焦点、失焦恢复、鼠标选区、主/回复窗口切换、候选窗定位和捕获保护实测。
- native helper 协议 v2 与预编译 release 资源的最终一致性验证，包括固定 tag、SHA-256、schema 资源和目标平台打包内容。
- 在平台实测结果支持后，单独决定是否移除或替换现有 `readOnly`/系统 IME 隔离；在此之前不得将其视为已完成。

## 后续实施计划

1. **平台验证矩阵**：在 Windows 11 和 macOS 分别执行中文/ASCII 切换、组合中 Shift、快速连续 Shift、数字候选、ASCII 数字、失焦恢复、目标切换、选区替换和高 DPI 多屏候选定位，并记录事件轨迹与 helper 日志。
2. **协议与资源收口**：核对 helper v2 握手、`get_option`/`set-mode` 返回值、schema 行为及 release SHA-256；发现协议差异时先修 native adapter/资源，不在组件中增加特殊分支。
3. **平台隔离决策**：依据两平台实测决定保留当前 `readOnly` 边界、按平台替换隔离能力，或明确记录平台限制；该决策单独新增 Note，不与 session 架构回退绑定。
4. **端到端验收**：补充可运行的 Electron/原生 helper 验收脚本，证明每个物理按键至多一次文本写入、旧 target composition 不会提交到新 target、外部失焦恢复不污染草稿。
5. **提案转实施 Note**：上述平台和资源证据齐全后，将本提案迁移到 `docs/notes/implemented/architecture/`，并同步更新相关历史 Note 的冲突描述；若平台隔离方案被否决，则另建 `rejected` 或平台限制 Note。

## 模块边界

- `packages/shared`：只定义 session snapshot、命令/结果、输入路由枚举和 bridge 类型；作为 main、preload、renderer 并行开发的契约冻结点。
- `apps/desktop/src/main/ime/rimeEngineAdapter.ts`：native helper 生命周期、协议版本、Rime 模式和组合状态映射；由 IME/native 维护者负责。
- `apps/desktop/src/main/ime/imeSessionManager.ts`：会话 reducer、owner lease、generation/revision、串行命令调度；由 main 架构维护者负责。`imeIpc.ts` 只验证来源和转发 typed command。
- `apps/desktop/src/preload`：仅转发 shared ChannelMap，不缓存模式、不改 payload。
- `packages/ui/src/ime/ImeInputCoordinator.ts` 与 `useImeTextTarget`：当前 renderer 活动目标、snapshot 订阅和统一事件路由；由 UI 输入基础设施维护者负责。
- `packages/ui/src/ime/adapters/`：textarea/input/CodeMirror 各自的 selection、insert、caret 接口；不同编辑器可并行维护，但必须通过相同 adapter contract。
- `packages/ui/src/components/panels/`：Chat、Reply、Settings、Workspace 只声明 targetId、编辑器 adapter 和业务提交回调；禁止自行维护输入模式、IME key mapping 或候选 lifecycle。
- `imeCandidateWindowController.ts`、`ImeCandidateAnchorReporter` 与 `windowSurfaceRegistry.ts`：消费统一状态，不拥有或改写引擎输入状态。

并行顺序：先由 shared/main/UI 负责人共同评审并冻结 command/snapshot/adapter contract；随后 engine adapter、session manager 和 renderer adapters 可在各自目录并行实现。候选/窗口团队仅适配 snapshot 订阅。集成负责人维护跨包契约测试和最终验收；不得让多个小组同时修改 `useEmbeddedIme.ts` 或 `imeIpc.ts` 作为共享“总入口”。

## 曾考虑的替代方案

- **只把 `asciiMode` 从 hook 移到 React context：** 舍弃。它能减少 renderer 内部重复，但仍无法证明 librime 的真实模式，也无法解决 main session、focus lease 和 UI 输入路由状态不一致。
- **一次性重写 session、所有编辑器和系统 IME 隔离：** 舍弃为第一阶段方案。它把 main/native 协议、DOM 编辑和平台焦点三种不同风险绑在一次迁移中，难以定位回归；先建立 main 权威契约和状态测试，再逐层迁移。
- **每个输入框各自保存中英文模式：** 舍弃。当前 librime 是共享 session，组件本地模式会在目标切换时与引擎状态分叉；若将来需要 per-field 模式，必须由 main session 以 targetId 显式持久化，而不是组件私有 state。
- **继续用 `readOnly` 阻止系统 IME，再用虚拟 caret 修补：** 舍弃为通用架构。该做法将编辑能力和引擎模式捆绑，并导致不同控件依赖额外视觉光标。替代是独立验证平台级系统 IME 隔离，再由 editor adapter 控制文本写入和原生 caret；若某个平台无法可靠隔离系统 IME，必须作为平台能力缺口处理，不能静默回退。
- **ASCII 下让系统输入法接管普通字符：** 舍弃。系统输入源、组合事件和应用隐私策略各异，会重新引入已观察到的系统 IME 暴露风险。
- **Shift 时无条件提交或 reset 活动拼音：** 舍弃。前者可能把编码写入用户文本，后者会静默丢失拼音；模式切换必须由引擎返回明确的 composition 转换结果。
- **仅依赖组件测试验证数字不重复：** 舍弃。重复可能出现在物理事件、Electron IPC、native engine commit 或 controlled editor 多层；需要路由单元测试、shared/main 命令测试和 renderer 端到端一次性插入测试共同证明。

## 验收标准

- 可观察结果：Shift 切换后所有支持的应用内文本框使用同一权威模式；快速连续按键在模式请求期间按队列顺序处理；组合中的 Shift 不会让拼音无声消失或写入草稿；输入框鼠标聚焦后 caret/selection 可见；应用失焦仅隐藏候选并暂停输入，恢复后 owner、模式和 composition 状态有明确结果。
- 可观察结果：空组合时按 `5` 恰好插入一个 `5`；活动组合中数字只选择 Rime 候选，不额外插入数字；ASCII 模式数字、小数点和字母恰好各插入一次；API Key/password 等 excluded 控件不接管、不记录输入。
- 自动化验证：纯 session reducer 覆盖 acquire/target switch/suspend/resume/release/late response；Rime adapter 契约验证模式返回、Shift keydown/keyup、活动 composition 模式切换结果；key router 测试每个输入事件只有一个 route/commit；textarea/input/CodeMirror adapter 测试 selection replacement、caret 和一次性 insertion；IPC 测试 sender/generation/commandId/revision 验证；候选显示/隐藏测试证明不改 mode/composition；多控件集成测试覆盖 Chat → Settings → Workspace 的模式保持。
- 自动化验证：用事件轨迹测试数字、Shift 与普通字符，并断言 route、preventDefault、engine command 和 editor value 之间的一一对应；不能只测试 hook 的局部 mock 回调。
- 第一阶段门槛：session reducer/manager 测试证明输入目标 acquire、release、suspend、resume 不改输入模式；切换目标先取消旧 composition 且不向新目标提交；renderer/target 销毁取消 composition；旧 generation/command 结果不改变当前快照。
- 需要的实机验证：Windows 11 与 macOS 分别验证中文/ASCII 跨输入框切换、Shift 活动组合策略、快速键入、数字候选/直接输入、系统 IME 不介入、鼠标 caret/selection、主/回复窗口切换、外部应用失焦恢复、隐身捕获保护及高 DPI 多屏候选位置。原生 helper 改版必须验证资源 SHA-256 与打包内容。

## 风险

- Rime schema 对 Shift 与活动 composition 的行为由 native helper 决定；需要 Windows/macOS 实测后锁定切换策略，不能以 `handled` 单字段推断模式是否改变。
- 权威模式查询要求更新 native helper 协议和预编译二进制，并按资源版本、来源和 SHA-256 流程发布；这比单改 renderer hook 成本高，但否则无法满足单一事实来源。
- Windows 与 macOS 的系统 IME 隔离能力不同。将 `readOnly` 从模式开关中移除前，必须证明各平台不会把系统组合重新接入受保护输入框；若不能证明，按平台明确限制，不做不安全回退。
- 共享模式跨输入目标保留会改变当前“每次 acquire 回到中文”的行为。必须确认目标切换时模式保留、组合取消的用户预期，并将测试及 UI 指示器统一到该策略。
- 在 session manager 替换现有 hook/IPC 之前，需要兼容旧 candidate IPC 的 generation/target 约束，分阶段迁移，避免一次改动同时重写 native lifecycle、编辑器和窗口层级。
