# Note：内置输入法权威会话状态与文本路由

状态：提案

## 问题

当前输入法把 Rime 引擎状态、输入框焦点、文本编辑和候选窗口展示拼在同一条 renderer hook 链路中。Rime session 在 main 进程共享，但 Shift 被 renderer 改写成绝对 `setInputMode` 命令，绕过 Rime schema 对左右 Shift keydown/keyup 的原生处理。renderer 还按 hook 实例生成重复的 `ui-1` 等 command ID，而 main 的幂等缓存只按 webContents 和 command ID 去重；同一 renderer 内多个目标可能拿到另一命令的缓存结果。

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
- 全应用只允许一个 main-owned Rime engine session 和一个 owner lease；输入框不创建或缓存自己的引擎实例。目标转移是一项不可观察中间态的 main 队列事务：停止旧目标接收新事件、清除旧候选展示、reset 旧 composition、推进 generation 并授予新 owner、确认新窗口系统 IME 隔离后返回新 lease。snapshot 查询与转移共用同一队列。
- 转移时只保留 Rime session 的全局输入模式；旧目标的 preedit、候选、选中项和待提交文本必须清空，不能 commit 给旧目标或暴露给新目标。新目标从空 composition 开始；旧 generation 的按键和候选动作一律拒绝。
- 当前应用窗口暂时失焦时，将 lease 标记为 suspended，暂停接收按键并隐藏候选；composition 与模式留在 main session，仍属于原 target。恢复时必须重新确认同一 owner 和 DOM target 后才能继续输入。
- 原 target 卸载、所属 renderer 导航/reload/crash 或窗口关闭时，撤销 lease 并取消其 composition；不能将 composition 留给后续 target。
- 会主动打断文本输入的应用动作（例如从 composer 启动截图捕获）必须在改变焦点或启动捕获前，通过当前 owner 的输入事务显式执行 `cancelComposition`。取消清除未确认的 preedit、候选和选中状态，不产生 commit；已提交 draft 与 composition 起始 selection 保持不变，session 全局输入模式保持不变。普通候选 popup 隐藏、窗口暂时失焦仍分别遵守 presentation-only 与 suspend 规则，不能被当作取消命令。

Shift 是 Rime 引擎输入事件，不是 renderer 的模式命令。当前 schema 与 librime 决定左右 Shift keydown/keyup、副作用及 composition 变化；renderer 将物理 Shift 的两条边都作为带 release 标记的 `processKey` 命令发送，main 只按队列顺序转发并发布 helper 返回的权威状态与 commit。renderer 不猜测、不强制设置模式，也不对 composition 做隐式提交、取消或保留；文本路由只消费引擎确认后的 snapshot。命令 ID 必须在一个 renderer 生命周期内全局唯一；main 只对相同 ID、相同 payload 的重试返回缓存结果，同 ID 不同 payload 必须拒绝。

### Renderer 输入事务契约

renderer 内的活动输入目标、按键序列和编辑器写入必须由一个 `ImeInputCoordinator` 协调，不能由每个 `useEmbeddedIme` 实例各自维护队列和路由状态。每个物理按键以不可变事件记录进入同一条有序队列；事件执行时，协调器依据队列前序命令返回的最新权威 snapshot 决定后续路由，不能在入队前使用可能过期的 `inputMode` 或 `composing` 预先分支。

受管 target 取得 lease 后，可能写入文本的浏览器默认行为必须在当前 DOM 事件栈内被阻止。随后由协调器将按键交给 main/Rime；事务结果必须包含引擎是否消费该键、最新 snapshot 和可选 commit。引擎消费的按键不再写入编辑器；引擎未消费且事务快照允许文本输入时，由该 target 的 editor adapter 执行一次明确的编辑命令。不得等待异步 IPC 后再决定是否阻止已经发生的 DOM 默认写入。

Rime preedit 与候选属于引擎会话，但由不同 presentation owner 呈现：活动 preedit 必须在当前编辑器的组合光标位置显示；候选列表由独立候选 presentation surface 显示在该组合光标下方，而不是固定在输入框边缘或下方。preedit 不属于候选列表，也不写入持久 draft。editor adapter 负责 composition 起始 selection、临时 preedit 展示、composition caret 几何、commit 替换和 cancel 恢复；其临时呈现可以使用编辑器原生 composition 支持、decoration 或 overlay，但必须保持控件的文本布局、选区和光标行为一致。候选 controller 只负责候选项、选中项、翻页和定位，不复制或拥有 preedit。只有 editor adapter 收到带 commandId/revision 的引擎 commit 后，才将确定文本写入 draft 一次。

截图捕获等显式打断动作通过 `ImeInputCoordinator` 排入当前目标的同一条 FIFO：先发送 `cancelComposition` 并应用确认后的空 composition snapshot，再执行焦点转移或启动捕获。若取消命令失败或 owner 已变化，不得把旧目标内容提交给新目标；动作按调用方既定失败策略中止或继续，但不得伪造成功 commit。普通 blur/候选隐藏不等价于此应用动作。

平台系统 IME 抑制由 main 的 `ImePlatformIsolation` 能力负责，不能用引擎语言模式推导 editor adapter 是否可写。renderer 的 DOM `readOnly` 只表示浏览器原生文本变更暂时被路由到 editor adapter；它不表示编辑器业务上不可编辑，也不能代替平台隔离状态。现有 DOM 输入保护与平台保护在各目标平台完成隔离验证前保持 fail closed，不因事务架构迁移而移除。

### Composition Presentation Contract

- 编辑器的持久 document/draft 只包含已提交文本。composition 开始时，adapter 保存原始 selection；随后的 Rime preedit 在该 selection 处作为临时组合呈现，不能作为普通键入逐字写入业务 draft。
- textarea/input 与 CodeMirror 可使用不同内部呈现机制，但共享 `beginComposition(selection)`、`updateComposition(preedit, compositionSelection)`、`commitComposition(text, commandId, revision)`、`cancelComposition()` 和 `getCompositionCaretRect()` 语义。preedit 在编辑器内的 composition 起始 selection 处临时呈现，视觉组合光标随 composition selection 更新；commit 恰好替换 composition 起始范围一次并把 caret 放在提交文本之后；cancel 移除临时 preedit、清除 bookmark 并恢复原 selection，不改已提交 draft。
- 候选列表消费同一权威 snapshot，但只呈现候选和选择状态，锚点取自 adapter 的 composition caret 矩形，候选窗顶部必须位于 caret 下沿。若屏幕工作区下沿空间不足，保持候选窗在 caret 下方并限制 popup 可用高度、允许候选列表滚动；不得翻到 caret 上方，也不得退化为锚定输入框边缘。横向位置应限制在所属 display 的 work area 内。候选窗口的 show/hide 和边界布局不改变 composition。不能按 preedit 字符数修改持久 document 的 DOM selection 来估算锚点。
- renderer adapter 上报相对所属编辑窗口 viewport 的 CSS pixel 矩形；main 的候选窗口 controller 是唯一坐标转换者，负责映射到 Electron screen DIP 并应用 display work area 约束。renderer 不乘 `devicePixelRatio`，main/controller 不再重复叠加窗口偏移或 display scale。缩放、多屏和窗口移动测试需覆盖该坐标契约。

### 各编辑器的 Composition 呈现策略

统一 adapter 契约之下，呈现技术按编辑器选定，不能把“preedit 临时放在编辑器里”留给各组件自行解释：

- **textarea/input**：持久 `value` 仍是业务 draft。composition 活动时，由 adapter 维护原始 selection bookmark 和 composition selection；一个与控件同步滚动、字体、换行、内边距和尺寸的只读 mirror layer 渲染 `draft[0:start] + preedit + draft[end:]`，即 preedit 在视觉上临时替代 composition 起始选区。真实 input 控件继续接收焦点和键盘，但其文本绘制及原生 caret 在组合期间隐藏；mirror 负责绘制投影文本、preedit 样式和组合光标。候选 anchor 从 mirror 的组合光标 marker 测量。禁止把临时拼音拼入 React/业务 draft，亦禁止只在候选 popup 展示拼音。
- **CodeMirror**：adapter 以映射 selection bookmark 保存替换范围，通过 StateField/Decoration 在该范围替换呈现 preedit，并在 decoration 中放置独立 composition caret marker；不向 CodeMirror document 发出 composition 文本 transaction。候选 anchor 直接测量 marker 的 DOM rect。引擎 commit 到达后才通过一次 document transaction 替换 bookmark 范围；cancel 移除 decoration 并恢复 bookmark 选区。
- **生命周期**：第一个有效 preedit 到达时执行 begin；后续权威 snapshot 更新 preedit 与 composition selection；带 commit 的结果先按 commandId/revision 对 draft/document 执行一次替换，再清掉投影；权威空 composition 且无 commit 时清投影并恢复原 selection。显式 cancel、target release 和 renderer 销毁使用同一清理语义。UI 不得仅凭 `preedit === ""` 自行 reset 引擎。
- **退化处理**：mirror/decoration 尚未完成、composition caret marker 不可测量或 target 已失效时，候选 presentation 隐藏并报告 anchor unavailable；不得猜测输入框边缘作为替代锚点。composition 状态仍由 session 保有，直到权威 commit/cancel/release。
- Shift keydown/keyup 按原始顺序交给 Rime。每个响应以一个 revision 原子更新 `inputMode`、`composing`、`preedit`、候选和可选 commit；renderer 不以 `handled` 推导模式。模式变为 ASCII 后，下一普通字母由 editor adapter 写入一次，不需要额外 Enter；如果 schema 在活动 composition 中保留或转换 preedit，则该 preedit 仍显示在编辑器内，按 schema 返回的候选/commit 规则确认。应用层不擅自提交或取消。
- 输入事件诊断必须能关联 renderer 物理事件与 main 命令结果：target、generation、顺序/command ID、key/code/release、前后 revision、mode、composing、preedit 长度、候选数、handled/accepted、editor route/write 与 focus/lease 状态。诊断默认不记录完整 preedit、候选或 commit 文本，避免输入内容泄露。

Ctrl/Alt/Meta 浏览器快捷键、编辑器导航和非文本命令须在契约中标明由谁处理；目标 lease 之外继续使用原生编辑器行为。IME engine command 的 accepted、engine handled 和 editor fallback 是不同结果，不能混为一个布尔值。

本阶段明确不改变系统 IME 隔离机制，也不移除输入控件现有 DOM `readOnly`/平台隔离行为。系统 IME 隔离与输入模式、editor adapter 写入能力解耦，但实际替换隔离能力必须另立平台验证决策；Windows/macOS 未分别验证前，不得以当前架构重构为由重新开放系统 IME。

隔离与编辑职责的代码契约：main 的窗口隔离调用返回有区分度的状态（`applied`、`not-required`、`failed`），调用方只允许 `failed` 阻止 lease；`not-required` 表示该平台没有由此 native API 执行隔离，不构成平台实测通过。renderer 文本策略使用 `blockNativeEditing` 描述 DOM 原生变更路径是否暂停；editor adapter 的显式命令仍可写入 draft。业务 `disabled` 仍由控件自身决定，不由输入模式或隔离状态推导。此契约阶段只澄清所有权和状态含义，保持现有 fail-closed 路由行为。

定义单一 `ImeSessionSnapshot`，至少包括：

- `phase`：`idle | owned | suspended | unavailable | disposed`。
- `owner`：window/webContents、targetId 和 generation。
- `engine`：启用状态、权威 `inputMode`、composition/preedit、候选和选择状态。
- `revision`：每次引擎状态变化递增，用于拒绝迟到结果。

定义命令及结果：

- `acquireTarget`、`releaseTarget`、`suspend`、`resume` 管理 owner lease，不修改输入模式，除非显式执行会话结束。
- `processKey` 接收目标、generation、物理 key/code、修饰键、keydown/keyup 与唯一 commandId；结果返回 `accepted`、`consumed`、权威 snapshot 和可选引擎 commit。
- Shift keydown/keyup 使用 `processKey`，以原始物理 key/code、修饰键和 release 标记交由 Rime；禁止 renderer 把它改写为 toggle 或绝对模式设置。
- `cancelComposition`、`selectCandidate` 是显式编辑命令，不由候选窗显示/隐藏或 input `blur` 隐式触发。
- 引擎 commit 带 commandId/revision，只能应用一次；renderer 对重复结果按标识去重。

引擎模式、输入编辑、候选展示和隐私策略是相邻但独立的状态域：

- **Rime engine adapter**：唯一包装 native helper 协议；提供启动握手、key processing、真实模式查询和 commit。Shift 语义由 Rime/schema 决定，helper 不得另造 Shift toggle。旧协议必须 fail closed。helper 协议版本、原生二进制、schema 与固定 SHA-256 资源必须一起发布。不得只改 C++ 源码就声称 `pnpm dev` 已验证；遵守仓库预编译资源约定。
- **Main `ImeSessionManager`**：唯一持有 session snapshot、owner/generation、command queue 和状态转移；校验 sender 与迟到结果；不读 DOM，不操作草稿。
- **Renderer `ImeInputCoordinator`**：订阅 snapshot，维护当前 renderer 内活动 target，调用 typed bridge；不维护第二份 `asciiMode`，不在组件里排队或 reset 引擎。
- **Editor adapters**：textarea/input 与 CodeMirror 分别负责持久 selection、composition bookmark、编辑器内临时 preedit 的布局/绘制、composition caret 矩形、文本替换和 undo/redo；通过统一接口报告焦点/选区/组合光标并应用一次性 `insertText`/engine commit。不知道候选窗层级或捕获保护细节。
- **Key router**：唯一按键策略入口，返回明确路由结果 `engine-consumed | editor-inserted | browser-shortcut | ignored`。活动 composition 中的数字是 Rime 候选键；无 composition 的数字只走一次 editor insertion；ASCII 文本只走 editor 原生文本事件。每种路由明确是否调用 `preventDefault`，不能同时调用 Rime commit 和 DOM 默认插入。
- **Caret/anchor reporter**：从当前 editor adapter 获取 composition caret 矩形并转换到屏幕坐标；composition 活动时不得以持久 document 的 DOM selection 或输入框矩形代替。视觉 caret 不决定输入模式，也不写入草稿。
- **Candidate presentation controller**：候选窗口只订阅 engine 候选状态、当前 owner 和 adapter 提供的 composition caret 矩形；默认贴合组合光标下方，并处理工作区边界。显示/隐藏和位置调整都是 presentation 状态，不能 reset 或切换语言模式。
- **Window surface/privacy controller**：负责窗口层级、non-activating、原生焦点和捕获保护；只通知 session suspend/resume，不直接修改 editor 或 Rime composition。
- **Text input policy**：纯策略只根据当前目标 lease、main 权威输入模式和 composition 决定文本事件路径：lease 正在接管且中文模式时，字符由 Rime 处理并阻止 native 文本写入；ASCII 模式或目标未被 lease 接管时，文本由编辑器处理；系统 composition 只在目标 lease 接管期间由该目标拦截。退格在组合期间交给 Rime，否则回到编辑器 adapter。现有 `readOnly` 仍是 Windows 系统 IME 隔离的一部分，不能随策略抽取而移除；平台级 native 隔离与 renderer 的目标级事件策略各自独立，Windows/macOS 的替换隔离能力留待单独验证。模式切换不得重新启用系统 IME。

输入模式策略与 IME 开关分开：全局功能设置决定是否接管受支持的文本目标；每次 target lease 决定按键当前交给哪个 owner；引擎 `inputMode` 决定中文组合或 ASCII 文本路径；窗口隐私策略决定候选与编辑窗口是否受保护；平台隔离能力决定系统 IME 是否可介入。不得复用一个 `active` 布尔值表示这些含义。

当前分支已具备 session manager、revisioned snapshot、typed IPC、编辑器 adapter、统一文本策略，以及 Rime 原生 Shift 事件贯通和命令幂等保护。renderer 多 hook 已共用 FIFO，并将 engine handled 与 IPC accepted 分开。Backspace/Delete/方向键的 composition 相关决策现在在队列执行时读取最新权威 snapshot；editor fallback 使用 typed command，由受控文本或 CodeMirror adapter 执行。浏览器快捷键同步放行，目标 lease 和 snapshot 尚不可用时不拿旧 hook state 代替。Chat/Reply textarea 和通用 `EmbeddedImeInput` 使用独立 composition mirror；CodeMirror Markdown editor 使用映射 bookmark 与 decoration。业务 draft/document 不含 preedit，候选 anchor 读取 composition caret marker；候选 surface 不绘制 preedit，原生候选窗口保持在 caret 下方并按剩余 work area 缩高。以上有 DOM/adapter 定向测试，但没有 Windows/macOS 实机几何证据。截图捕获等打断动作的显式取消契约仍待接入和验收。文本隔离仍和 `readOnly`/模式耦合，因此架构迁移尚未收口。Electron 系统 IME 隔离、平台行为和发布资源一致性也尚未验收。

候选鼠标动作、候选翻页和候选选择也必须继续共用同一队列。下一阶段先完成 editor composition projection 与打断动作取消契约，再继续平台系统 IME 隔离和 editor writable 状态的分离。

1. 冻结 shared snapshot/command/result 与状态转移规则，标明字段权威来源和 stale command 拒绝条件。
2. 在 main 建立 `ImeSessionManager`，集中 owner/generation、模式、composition、命令队列和 revisioned snapshot；现有实现通过 session、IPC 和全量架构门禁。`imeIpc.ts` 保留旧的领域操作入口，同时以 typed session command 统一按键状态转移；preload 可查询并订阅 main snapshot。
3. 增加 session reducer 与 IPC 契约测试，证明 acquire/release/suspend/resume 不意外修改输入模式，目标切换与销毁按上述 composition 规则处理。
4. `useEmbeddedIme` 已订阅快照并使用 typed session command；key router 将 Shift 两条物理事件交给 Rime，命令 ID 在 renderer 生命周期内唯一，main 对相同 ID 的不同 payload 拒绝重放。文本 adapter、候选 snapshot 投影已有实现。候选 renderer 只消费 main 发布的快照。系统 IME 隔离与 `readOnly` 保持现状，平台隔离能力没有因此获得实机证明。

## 当前实施状态

现有实现已完成 session、IPC、文本 adapter、文本策略和 Rime 原生 Shift 路由的基础改造；架构契约及平台行为尚未全部验收：

- main 进程通过 `ImeSessionManager` 持有输入模式、composition、候选和 owner/generation/revision；target lease 不再决定语言模式。
- shared/preload/renderer 使用 typed session snapshot 和 command/result；generation/revision 校验已实现，renderer 使用 UUID commandId，main 对相同 ID/相同 payload 幂等返回、对相同 ID/不同 payload 拒绝。command result 分开表达 session accepted 与 Rime `engineHandled`。
- renderer 的多个 hook 实例共用一个输入 FIFO；Shift 与可打印字符先阻止 DOM 默认文本写入，再按引擎权威响应决定是否由 editor callback 插入。快速 Shift 后字符的队列契约有回归测试。
- Shift keydown/keyup 作为原生按键事件交给 Rime，模式、composition、候选与 commit 只从 helper 权威响应投影；应用层不再提供绝对模式设置命令。
- 候选窗口只提交 target、generation 和屏幕锚点，展示数据由 main 从权威 session 投影；候选显示/隐藏不再 reset composition 或切换模式。
- input/textarea 与 CodeMirror 通过同一 `imeTextPolicy`、key router 和 editor adapter 决定 native text、Rime、composition、backspace 和 preventDefault 路径；每个事件只有一条写入路径。
- Chat/Reply textarea 与通用 `EmbeddedImeInput` 的业务 value 只包含已提交文本；composition 活动时通过只读 mirror layer 将 preedit 临时替换显示在 composition 起始 selection 处，mirror caret marker 为候选 anchor 提供几何。CodeMirror Markdown editor 用 `StateField` 保存并映射 composition bookmark，以 `Decoration.replace` 呈现临时 preedit，不修改文档 transaction；commit 仍走 CodeMirror document adapter。候选 popup 只呈现候选项；main 候选窗口布局保持在 caret 下方，按 work area 剩余高度缩放，无下方空间时隐藏并记录状态。Chat、input、CodeMirror adapter、anchor reporter 和布局定向测试覆盖 DOM 投影、selection 替换和 bookmark 映射；尚未证明真实字体换行、DPI 映射和 Windows/macOS 原生窗口位置。
- Chat、Reply、Markdown editor 等入口已迁移到统一策略，并补充了 session、IPC、候选、key router、adapter、文本策略和组件回归测试。
- 新增 renderer 事务集成轨迹：通过真实 `useEmbeddedIme` hook 和 controlled-text adapter 验证按键、候选 PageDown、候选选择、engine commit、selection replacement 与 Backspace fallback 的共享 FIFO 顺序；commit 一次写入并按 composition 起始选区替换。`pnpm verify` 通过，UI 144、desktop 127、app 7 项测试通过，含 lint、typecheck、Note 和 architecture checks。
- 增补 target switch 集成轨迹：旧 target 的按键请求挂起且另一个按键排队时切换 lease；确认 release/acquire 顺序、旧队列操作被丢弃、迟到的旧 target commit 不写入，新 target 在 lease 获得后可处理按键。HTML input selection fallback 也有实际 DOM adapter 测试。最终 `pnpm verify` 通过：UI 146、desktop 127、app 7 项测试，lint、typecheck、Note 与 architecture checks 均通过。
- 增加 CodeMirror 生命周期集成轨迹，连接实际候选窗状态、候选 anchor reporter、候选鼠标选择、engine commit 与编辑器 selection replacement；随后再次开始 composition 并 release target，确认 draft、selection 均不变且候选 presentation 清空。
- 上述 CodeMirror/候选集成轨迹验证的是当前 presentation 行为；需要在新的 editor composition projection 与 caret geometry 契约下扩展，不能据此声称候选窗已按组合光标定位。
- adapter 边界决定：Chat/Reply 共享受控 textarea selection bookmark、engine commit 替换和 caret 恢复，因此抽成 textarea 专用 hook；CodeMirror 保留自身 adapter，因为 selection 与历史由 CodeMirror transaction 管理。共同接口继续限定在 key router typed command 和 `onCommit(text)`，不引入无法表达两种 selection 生命周期的泛型 bookmark。
- `useControlledImeTextAdapter` 已落地并由 Chat/Reply 共用；测试覆盖 composition 起始 selection 不被后续按键覆盖、commit caret 恢复和 cancel 清除 bookmark。CodeMirror 与候选窗联合生命周期测试也覆盖鼠标选择 commit、release cancel 不改文档/selection。
- 2026-10-16 补齐 `EmbeddedImeInput` 的 controlled-text projection 和 caret anchor；CodeMirror 增加映射 composition range 的 `StateField` 与 replace decoration，preedit 更新不写 document，commit 仍由现有 editor adapter 写入。修正 mirror 在 input ref 尚未挂载时同步导致 portal 永不显示的问题；textarea/input composition mirror 在目标控件挂载后测量。
- 2026-10-16 增加 CodeMirror 投影/bookmark 映射测试；UI 定向 45 项通过，UI typecheck 通过。候选 anchor reporter 测试现在使用实际 composition projection marker 的 DOM 结构。
- 本轮最终验证：`pnpm verify` 通过，UI 148、desktop 127、app 7 项测试通过，lint、全包 typecheck、Note 门禁和 architecture check 均通过。
- 隔离/编辑器契约收口：renderer policy 用 `blockNativeEditing` 描述浏览器直接变更门控；editor adapter 命令仍可写入。main 用 `isolateNativeIme` 返回 `applied | not-required | failed`；`failed` 仍阻止或暂停 lease，`not-required` 保持原有平台路径但不作为实机隔离证据。定向 UI 9 项、desktop 15 项测试与两包 typecheck 通过。
- 2026-10-16 文本隔离收口为"受管目标恒只读"：`imeTextPolicy` 去掉 `inputMode` 分支，lease 持有期间 `readOnly`/`blockNativeEditing`/`blockComposition` 恒真，模式只影响按键路由；`useStealthInputGuard` 对 `[data-embedded-ime-target]` 只取消 composition、不再 blur 或写失败标记，隐身关闭时零副作用。这消除"ASCII 模式重新变成原生文本目标"的路径，但**没有**改变 `readOnly` 仍同时承担"阻止浏览器原生文本写入"和"阻止系统 IME 接管"两个职责的事实。
- 2026-10-16 候选面尺寸契约：候选窗尺寸只能来自 renderer 上报的**未裁剪内容尺寸**（`scrollWidth/scrollHeight`），上限只能是常量或 main 的 work area；禁止测量依赖当前窗口尺寸（`100vw`/`vh`/`%`/`flex-shrink`）。见[候选窗宽度棘轮](../../implemented/bug-fix/2026-10-16-ime-candidate-window-width-ratchet.md)。
- 2026-10-16 排障复盘：主进程硬崩溃靠"某条日志缺失"反推（见[FFI 字符串解码崩溃](../../implemented/bug-fix/2026-10-16-native-ffi-string-decode-crash.md)），候选窗宽度棘轮全程**没有任何日志**能直接回答"上报尺寸 vs 窗口尺寸"，Shift 锁死需要逐条读 guard 代码才能定位。三次故障都不是"缺抽象"，而是**缺唯一写入者**与**缺默认可见的因果链证据**。
- 2026-10-16 **S1 可判定性已交付**：`lease-released` 一律带 `reason`，覆盖 renderer `releaseTarget`（含 `target-switched`/`effect-inactive`/`editor-unmount`/`acquire-rejected`）、`owner-window-closed`/`renderer-process-gone`/`window-navigation`、`owner-replaced` 与 `native-ime-isolation-failed`（另加 `lease-unavailable` 行），并补 `lease-resumed`/`lease-suspended`；焦点链 4 个 `renderer-*-focus/blur` 与 `candidate-native-positioned` 取消默认 suppress，后者新增 `requestedSize`/`candidateBounds` 对照；shared 新增运行时事件名列表 `IME_RENDERER_DIAGNOSTIC_EVENTS`，main 白名单从它派生（此前手写数组漏掉 `release-called`，正是"释放原因丢失"的根因）。详见[IME 租约释放原因与默认焦点链日志](../../implemented/bug-fix/2026-10-16-ime-release-cause-diagnostics.md)。状态所有权未动，因此仍**不能**据此声称已解耦。

- 2026-10-16 **S2a renderer 单一写入者已交付**：`imeSessionClient` 成为唯一 session store（订阅 + `getImeOwnedGeneration`/`isImeTargetOwned`/`getImeInputMode`/`getImeComposing` 派生 getter，删除无消费者的 `getImeSessionRevision`）；`imeInputTargetCoordinator` 的活动 target 变为可订阅快照（`getActiveImeInputTargetId`/`subscribeImeInputTargets`）；`useEmbeddedIme` 删除 `asciiMode`/`asciiModeRef`/`generation`/`generationRef`/`focusedRef`/`targetEngaged` 六处副本，`state`/`generation`/`asciiMode`/`targetEngaged` 全部派生，`blur()` 改为注销注册，并新增"main 报告 session 空闲或归他人时注册自动失效"规则；wire 诊断字段 `focusedRef` → `targetRegistered`（与 `activeElementTarget`/`documentHasFocus` 三者语义分离）。`pnpm verify` 通过，UI 162、desktop 147、app 7 项测试通过。剩余：候选/锚点/窗口面副本（`ImeCandidateAnchorReporter` 的 `windowFocused` 与 `!anchor.readOnly` 门控）与 S3 一并收口。详见[renderer 侧状态副本收口](../../implemented/architecture/2026-10-16-ime-renderer-single-writer-facts.md)。

main/IPC 目标转移的自动化契约现已覆盖，但平台验证和资源交付仍未完成；不能据此放松现有 fail-closed 输入隔离：

- renderer FIFO 顺序、候选操作、一次性 commit、editor fallback，以及 target switch 时的 queued event cancellation/late result 已有集成轨迹；textarea 和 HTML input 有实际 selection adapter 覆盖，CodeMirror 有独立 adapter 和面板测试。
- renderer 的候选、anchor、commit/cancel selection 生命周期已分别由受控 textarea、HTML input 和 CodeMirror adapter 轨迹覆盖；不同 adapter 保留各自的 selection/history 实现，不强行统一内部接口。
- 隔离 API 和 renderer DOM 输入路由已有独立类型语义，但 Windows/macOS 的原生隔离能力仍未分别验证；完成实测前保留当前 fail-closed 输入保护。
- 并发 IPC 轨迹覆盖目标切换期间 reset 阻塞：新 owner/snapshot 在 reset 完成前不可见，转移结果不带 commit，输入模式保持全局 session 状态；旧 generation 的迟到按键和候选命令在新 lease 生效后被拒绝且不调用 Rime。
- Windows 本机 helper 冒烟验证：现有资源启动握手返回 `protocolVersion: 2`、`available: true`；启用后输入 `nihao` 产生 Rime preedit/候选，Shift keydown/up 原样转发后权威状态变为 ASCII，活动 composition 由 schema 转换为 `nihao`。该验证只覆盖 helper/schema，不代表 Electron UI、原生 IME 隔离或完整平台矩阵验收。
- 当前架构尚无 editor composition caret 的实机定位证据，也没有截图捕获前取消 composition 的集成轨迹；两项均列为 renderer 架构验收缺口。

- Windows 11 与 macOS 的真实输入法、窗口焦点、失焦恢复、鼠标选区、主/回复窗口切换、候选窗定位和捕获保护实测。
- native helper 协议 v2 与预编译 release 资源的最终一致性验证，包括固定 tag、SHA-256、schema 资源和目标平台打包内容。
- 在平台实测结果支持后，单独决定是否移除或替换现有 `readOnly`/系统 IME 隔离；在此之前不得将其视为已完成。

## 后续实施计划

1. **editor composition projection 收口**：Chat/Reply textarea、`EmbeddedImeInput` mirror 与 CodeMirror mapped bookmark/decoration 已落地并有定向测试。补齐多行、滚动、缩放、屏幕边界、CodeMirror commit/cancel 生命周期和真实窗口坐标验证。
2. **打断动作取消事务**：截图捕获等动作先在同一 FIFO 中 `cancelComposition`，确认空 snapshot 后才移焦/捕获；验证不产生 commit、不改变 draft/selection/全局模式，普通 blur 和候选隐藏仍不隐式取消。
3. **renderer 事务验收**：扩展 textarea/input/CodeMirror 集成轨迹，覆盖 begin/update/commit/cancel、composition caret 下方候选定位、候选键鼠操作、target release 和截图取消；按物理事件顺序断言每个确认文本只写入一次。
4. **协议与资源收口**：核对 helper v2 握手、权威 mode 返回、schema 行为及 release SHA-256；发现协议差异时先修 native adapter/资源，不在组件中增加特殊分支。
5. **平台验证矩阵与隔离决策**：在 Windows 11 和 macOS 分别验证原生组合呈现、Shift/字符事件轨迹、目标切换、selection replacement、候选贴合组合光标且不越出工作区、高 DPI 多屏、系统 IME 隔离与捕获保护；依据实测单独记录隔离决策。
6. **端到端验收与提案迁移**：用 Electron/原生 helper 事件轨迹证明每个物理按键至多一次文本写入、旧 target composition 不提交给新 target、取消不污染 draft、外部失焦恢复不污染草稿。平台和资源证据齐全后，迁移提案至 `implemented/` 并同步相关历史 Note。

## 模块边界

- `packages/shared`：只定义 session snapshot、命令/结果、输入路由枚举和 bridge 类型；作为 main、preload、renderer 并行开发的契约冻结点。
- `apps/desktop/src/main/ime/rimeEngineAdapter.ts`：native helper 生命周期、协议版本、Rime 模式和组合状态映射；由 IME/native 维护者负责。
- `apps/desktop/src/main/ime/imeSessionManager.ts`：会话 reducer、owner lease、generation/revision、串行命令调度；由 main 架构维护者负责。`imeIpc.ts` 只验证来源和转发 typed command。
- `apps/desktop/src/preload`：仅转发 shared ChannelMap，不缓存模式、不改 payload。
- `packages/ui/src/ime/ImeInputCoordinator.ts` 与 `useImeTextTarget`：当前 renderer 活动目标、snapshot 订阅和统一事件路由；由 UI 输入基础设施维护者负责。
- `packages/ui/src/ime/adapters/`：textarea/input/CodeMirror 各自的 selection、composition projection、insert、composition caret geometry 接口；不同编辑器可并行维护，但必须通过相同 adapter contract。
- `packages/ui/src/components/panels/`：Chat、Reply、Settings、Workspace 只声明 targetId、编辑器 adapter 和业务提交回调；禁止自行维护输入模式、IME key mapping 或候选 lifecycle。
- `imeCandidateWindowController.ts`、`ImeCandidateAnchorReporter` 与 `windowSurfaceRegistry.ts`：消费统一候选状态和 editor adapter 提供的 composition caret 矩形，负责候选窗锚定及工作区边界布局，不拥有或改写引擎输入状态。

并行顺序：先由 shared/main/UI 负责人共同评审并冻结 command/snapshot/adapter contract；随后 engine adapter、session manager 和 renderer adapters 可在各自目录并行实现。候选/窗口团队仅适配 snapshot 订阅。集成负责人维护跨包契约测试和最终验收；不得让多个小组同时修改 `useEmbeddedIme.ts` 或 `imeIpc.ts` 作为共享“总入口”。

## 曾考虑的替代方案

- **只把 `asciiMode` 从 hook 移到 React context：** 舍弃。它能减少 renderer 内部重复，但仍无法证明 librime 的真实模式，也无法解决 main session、focus lease 和 UI 输入路由状态不一致。
- **一次性重写 session、所有编辑器和系统 IME 隔离：** 舍弃为第一阶段方案。它把 main/native 协议、DOM 编辑和平台焦点三种不同风险绑在一次迁移中，难以定位回归；先建立 main 权威契约和状态测试，再逐层迁移。
- **每个输入框各自保存中英文模式：** 舍弃。当前 librime 是共享 session，组件本地模式会在目标切换时与引擎状态分叉；若将来需要 per-field 模式，必须由 main session 以 targetId 显式持久化，而不是组件私有 state。
- **继续用 `readOnly` 阻止系统 IME，再用虚拟 caret 修补：** 舍弃为通用架构。该做法将编辑能力和引擎模式捆绑，并导致不同控件依赖额外视觉光标。替代是独立验证平台级系统 IME 隔离，再由 editor adapter 控制文本写入和原生 caret；若某个平台无法可靠隔离系统 IME，必须作为平台能力缺口处理，不能静默回退。
- **ASCII 下让系统输入法接管普通字符：** 舍弃。系统输入源、组合事件和应用隐私策略各异，会重新引入已观察到的系统 IME 暴露风险。
- **Shift 时无条件提交或 reset 活动拼音：** 舍弃。前者可能把编码写入用户文本，后者会静默丢失拼音；模式切换必须由引擎返回明确的 composition 转换结果。
- **仅依赖组件测试验证数字不重复：** 舍弃。重复可能出现在物理事件、Electron IPC、native engine commit 或 controlled editor 多层；需要路由单元测试、shared/main 命令测试和 renderer 端到端一次性插入测试共同证明。
- **把 preedit 放在候选 popup 或固定在输入框边缘：** 舍弃。preedit 是编辑器当前 composition 的临时文本，必须跟随组合光标；候选是独立选择 UI，应贴合组合光标下方。输入框边缘定位在多行、滚动和窄窗口时会与真实输入位置脱离，也可能被视口裁切。

## 验收标准

- 可观察结果：Shift 切换后所有支持的应用内文本框使用同一权威模式；快速连续按键在模式请求期间按队列顺序处理；组合中的 Shift 不会让拼音无声消失或写入草稿；输入框鼠标聚焦后 caret/selection 可见；应用失焦仅隐藏候选并暂停输入，恢复后 owner、模式和 composition 状态有明确结果。
- 可观察结果：空组合时按 `5` 恰好插入一个 `5`；活动组合中数字只选择 Rime 候选，不额外插入数字；ASCII 模式数字、小数点和字母恰好各插入一次；API Key/password 等 excluded 控件不接管、不记录输入。
- 可观察结果：活动拼音作为临时 composition 显示在编辑器组合光标处，不进入 draft/document；候选窗顶部位于组合光标下沿，跟随多行换行、编辑器滚动和窗口移动，靠近屏幕下沿时保持在光标下方并限制高度、候选列表可滚动，靠近左右边缘时仍在 work area 内。确认候选只 commit 一次；截图捕获等显式打断动作取消 preedit/候选且不改 draft、selection 或输入模式。
- 自动化验证：纯 session reducer 覆盖 acquire/target switch/suspend/resume/release/late response；Rime adapter 契约验证模式返回、Shift keydown/keyup、活动 composition 模式切换结果；key router 测试每个输入事件只有一个 route/commit；textarea/input/CodeMirror adapter 测试 composition projection、caret geometry、selection replacement、cancel 和一次性 insertion；IPC 测试 sender/generation/commandId/revision 验证；候选定位测试证明锚点来自组合光标且边界布局不改变引擎状态；候选显示/隐藏测试证明不改 mode/composition；多控件集成测试覆盖 Chat → Settings → Workspace 的模式保持及显式打断取消。
- 自动化验证：用事件轨迹测试数字、Shift 与普通字符，并断言 route、preventDefault、engine command 和 editor value 之间的一一对应；不能只测试 hook 的局部 mock 回调。
- 第一阶段门槛：session reducer/manager 测试证明输入目标 acquire、release、suspend、resume 不改输入模式；切换目标先取消旧 composition 且不向新目标提交；renderer/target 销毁取消 composition；旧 generation/command 结果不改变当前快照。
- 需要的实机验证：Windows 11 与 macOS 分别验证中文/ASCII 跨输入框切换、Shift 活动组合策略、快速键入、数字候选/直接输入、编辑器内 preedit 与 composition caret、候选窗始终位于组合光标下方且下沿空间不足时可滚动、系统 IME 不介入、鼠标 caret/selection、主/回复窗口切换、截图取消、外部应用失焦恢复、隐身捕获保护及高 DPI 多屏坐标映射。原生 helper 改版必须验证资源 SHA-256 与打包内容。

## 风险

- Rime schema 对 Shift 与活动 composition 的行为由 native helper 决定；renderer 不得自行规定状态变化。必须用 helper 返回的完整 snapshot/commit 验证 Windows/macOS，不能以 `handled` 单字段推断模式是否改变。
- 权威模式查询要求更新 native helper 协议和预编译二进制，并按资源版本、来源和 SHA-256 流程发布；这比单改 renderer hook 成本高，但否则无法满足单一事实来源。
- Windows 与 macOS 的系统 IME 隔离能力不同。将 `readOnly` 从模式开关中移除前，必须证明各平台不会把系统组合重新接入受保护输入框；若不能证明，按平台明确限制，不做不安全回退。
- 共享模式跨输入目标保留会改变当前“每次 acquire 回到中文”的行为。必须确认目标切换时模式保留、组合取消的用户预期，并将测试及 UI 指示器统一到该策略。
- 在 session manager 替换现有 hook/IPC 之前，需要兼容旧 candidate IPC 的 generation/target 约束，分阶段迁移，避免一次改动同时重写 native lifecycle、编辑器和窗口层级。
- textarea、input 与 CodeMirror 的 composition 绘制和几何 API 不同；adapter 若只返回持久 selection 的矩形，候选会偏离临时 preedit 光标。必须以 mirror/decoration 中真实组合光标 marker 的矩形作为契约，并对多行、滚动容器、窗口缩放、DPI 映射及工作区边缘做自动化和平台验证。候选窗若在空间不足时翻到光标上方，会违背已确定的交互位置；应限制窗口高度并保留下方锚定。

## 2026-10-16 修订：可判定性与单一写入者优先

### 为什么先修这个

2026-10-16 连续三个故障（Shift 后输入锁死、FFI 解码崩主进程、候选窗宽度棘轮）复盘后确认：架构迁移走到一半时，"找不到问题"并不是因为抽象不够，而是因为

1. **状态有多个写入者**：焦点事实同时存在于 hook `focusedRef`、coordinator 模块级 `activeTarget`、DOM `activeElement`、main lease `owned/suspended` 四处；`asciiMode`/`generation`/`targetEngaged` 在 renderer 各有一份副本。日志只能记录结果，无法回答"这次是谁改的"。
2. **默认日志没有因果链**：`renderer-input-focus`/`acquire`/`blur`/`key-routing` 默认被 suppress（`imeDiagnostics.ts`），必须 `ANSWRA_IME_DEBUG=1`；候选面尺寸、焦点与 lease 的变化都没有一条"输入 → 结果"的完整链路可读。
3. **只能实机验证**：焦点/lease/候选时序没有确定性测试，改一次就要人工复现一轮。

因此本修订把"可判定性"和"单一写入者"提到功能收口之前：**先让每个状态只有一个写入者、每个状态变化在默认日志里可读，再谈新能力。**

### 硬性完成标准（不满足即不算解耦）

- **单一写入者**：焦点/lease 事实只由 main 的 `ImeSessionManager` 与 renderer 的 `ImeInputCoordinator` 各自持有唯一一份；renderer 组件不得缓存 `asciiMode`、`generation`、`targetEngaged`，只能从 snapshot 派生；coordinator 只登记当前活动 target，不再做第二套焦点判断。
- **因果链默认可见**：一次焦点变化在**不开** `ANSWRA_IME_DEBUG` 的默认输出里给出可读链路：`focus(target, window) → acquire(generation) → owned | suspended(reason) → release(reason)`，每条都回答"谁触发、什么原因、影响哪个 generation"。`lease-released` 必须带 `reason`，并覆盖 `releaseTarget`、`owner-destroyed`、renderer unmount、`unavailable` 四条来源。
- **无 Electron 可测**：焦点/lease/候选/sizing 的判定逻辑必须能在 vitest（无 Electron、无原生窗口）里用假时钟与假 bridge 驱动；需要原生窗口的部分只作为平台验证列出，不再作为"逻辑正确性"的证据。
- **契约受测试保护**：候选面"只上报未裁剪内容尺寸、上限只来自常量或 work area"一类不变量要有回归测试（候选窗棘轮已加一条）。
- **不把拆文件当解耦**：把 `useEmbeddedIme.ts` 切成多个文件、或把 controller 拆成多个对象，只有在**同时**消除了状态副本或写入者时才计为进度。

### 分阶段顺序

- **S1 可判定性（先做，2026-10-16 已交付）**：补齐默认可见的 IME 因果链日志；`lease-released` 带 reason 并覆盖四条来源（renderer `releaseTarget` 含 `target-switched`/`effect-inactive`/`unmount`/`editor-unmount`/`acquire-rejected`、`owner-window-closed`/`renderer-process-gone`/`window-navigation`、`owner-replaced`、`native-ime-isolation-failed`）；候选面记录"上报尺寸 vs 窗口尺寸 vs 锚点"。目标是"再看一次同样的故障，能从默认日志直接读出链路"。此阶段不改状态所有权，风险最低、收益最直接。
- **S2 单一写入者（S2a renderer 侧，2026-10-16 已交付）**：renderer 侧事实域收口完成——引擎/租约/模式/composition 只由 main 写，renderer 唯一 store 是 `imeSessionClient`（新增订阅与派生 getter）；"当前活动输入目标"只由 `imeInputTargetCoordinator` 写并作为可订阅快照暴露；DOM 焦点不再被缓存；`useEmbeddedIme` 删除 `asciiMode`/`asciiModeRef`/`generation`/`generationRef`/`focusedRef`/`targetEngaged` 六处副本，改为派生，并新增"main 撤销租约即注销注册"规则；wire 诊断字段 `focusedRef` → `targetRegistered`。详见[renderer 侧状态副本收口](../../implemented/architecture/2026-10-16-ime-renderer-single-writer-facts.md)。仍待完成：候选/锚点/窗口面（`ImeCandidateAnchorReporter` 的 `windowFocused` 与 `readOnly` 门控）的副本收口，以及 `imeEnabled` 以外的组件级派生审查。
- **S3 候选与窗口面解耦**：候选状态、锚点、窗口生命周期、层级和捕获保护分成独立写入者；候选展示不再与 suspend/hide/cancel/release 共用同一个 modify 批量变量。sizing 契约并入此阶段验收。
- **S4 清理与契约固化**：删除迁移遗留（如已无消费者的策略字段、只服务旧路径的分支）；把 S1–S3 的判据写成测试，允许后续并行改动在这里回归。
- **S5 平台验证与迁移**：Windows/macOS 实机矩阵、资源一致性、系统 IME 隔离决策；证据齐全后把本提案迁到 `implemented/` 并同步历史 Note。

### 并行开发边界

- `packages/shared` 的 snapshot/command/result 是本提案的冻结契约；任何阶段不得在 renderer 侧新增字段来解释 main 状态。
- S1 只允许改 `imeDiagnostics.ts` 与各调用点的日志参数，不碰状态所有权，因此可以和 S2 的会话/焦点改造并行（但不要同时改 `imeIpc.ts` 与 `useEmbeddedIme.ts`）。
- 编辑器 adapter、候选/窗口面、平台隔离分别由不同负责人维护；集成负责人只维护跨包契约测试。
- 结论：**只做 S1 不做 S2，可以显著降低排障成本，但不能声称架构已解耦；只做 S2 不做 S1，会失去验证解耦是否真生效的证据。两者必须一起做才满足本提案的验收标准。**

