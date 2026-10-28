# Note：IME 状态所有权与跨进程链路收敛

状态：提案

## 问题

IME 的状态并非全部放在同一个仓库中，但当前已存在若干明确的局部 owner，跨 renderer/main/native 的状态投影、编辑器逻辑位置和候选窗展示尚未形成可端到端核对的协议。结果是用户报告候选窗沿用旧词条、光标位置错误以及外部 focus-probe 页面 blur 时，日志无法稳定区分状态在哪个边界变旧或发生变化。继续在单个 hook、窗口或 native helper 上零散修复，会增加新的状态副本而不一定消除根因。

仓库已经有多份 implemented Note 声明 IME 的 single-writer 边界；因此问题不是简单地“缺少 Redux/Zustand”，而是**文档约束、当前实现和跨边界观测尚未统一成可以测试的事实**。跨进程状态不能由一个 renderer store 变成真正的单一内存状态；必须保留平台边界，并用明确协议传递权威快照。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`；`packages/ui/src/ime/`、`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/components/panels/ConversationComposer.tsx`、`packages/ui/src/components/panels/ImeCandidateAnchorReporter.tsx`、`packages/ui/src/app/ImeCandidateWindowApp.tsx`；`apps/desktop/src/main/ime/` 与 `apps/desktop/native/rime-host/`。
- UI/进程/协议/隐私表面：物理键盘捕获、活动输入 target、Rime composition/candidate、文本选区、候选展示与系统前台/焦点。
- 相关 Note：[权威会话与输入路由提案](2026-10-15-ime-authoritative-session-and-input-routing.md)、[renderer 单写事实](../../implemented/architecture/2026-10-16-ime-renderer-single-writer-facts.md)、[候选窗口单写边界](../../implemented/architecture/2026-10-16-ime-candidate-window-single-writers.md)、[非激活输入](../../implemented/architecture/2026-10-27-nonactivating-rime-keyboard-input.md)。本 Note 补充跨边界收敛和验收，不推翻这些 Note 中仍符合当前实现的局部 owner 决策。

## 模块边界

| 状态事实 | 唯一 owner / 当前来源 | 允许的下游职责 | 需要明确的失效条件 |
|---|---|---|---|
| 原生 hook 生命周期与捕获到的物理按键 | native helper 执行 hook；desktop main 决定启动、停止并按当前 lease 定向转发 | main 可验证并转发事件；renderer 只消费属于当前 target/generation 的事件 | hook 停止、管道失败、lease generation 变化、应用销毁或系统前台基线变化 |
| 当前 Rime 引擎状态 | main `RimeBridge` 持有引擎快照；`ImeSessionManager` 序列化命令并发布合并后的 session snapshot | renderer 的 `imeSessionClient` 缓存 main 快照用于渲染和发命令；它不是第二个权威引擎 | 每次引擎/lease 状态变更推进 main revision；target lease 释放或 generation 变化 |
| main 当前输入 lease | main `ImeSessionManager` / `imeSessionState` | IPC handler 校验 owner window、webContents、target、generation | release、suspend、owner 销毁、unavailable、dispose |
| renderer 正在接受输入的逻辑 target 与输入 FIFO | renderer `imeInputTargetCoordinator` | hook/组件请求激活、释放或排队，不另存 active-target 副本 | target 切换、release；排队命令执行时再次校验 active target |
| 文本值 | owning React surface / 其调用方 | adapter 通过编辑操作请求父层更新值 | 父层替换、清空、提交或卸载 |
| 逻辑选区、组合替换范围与 commit caret | 文本 adapter（如 `useControlledImeTextAdapter`） | DOM selection / composition mirror 仅作为视觉投影 | 文本替换、selection 操作、组合开始/结束、target release |
| 候选锚点 | editor anchor reporter 从目标编辑器布局/逻辑选区测量 | main controller 使用锚点做窗口定位 | target/generation 变化、编辑位置/布局变化、owner 销毁 |
| 候选窗口内容、尺寸、可见性和窗口生命周期 | main candidate window controller 保存当前 presentation 并控制 BrowserWindow | 独立 candidate renderer 只接收 snapshot 并绘制；用户 action 反向发给当前 lease owner | clear/suspend、candidate snapshot 变更、generation 变化、owner 销毁 |
| 操作系统实际前台窗口；probe DOM focus/blur | OS / 浏览器各自报告；没有单一跨平台 writer | main/native 记录带时间与窗口身份的观测，供关联分析 | 每个系统事件本身；不能从 Electron `focused` 推演 probe 是否 blur |

当前 `ImeCandidateSnapshot` 的 `revision` 是 main candidate controller 对 presentation 写入/清空分配的本地递增序号；candidate renderer 拒绝小于或等于当前序号的快照。它不等于 main session `revision`，也未关联 native `ImeKeyboardInput.eventId`，因此只能保护候选 renderer 的接收边界，不能证明或阻止上游旧状态被 main 当作新 presentation 发布。候选 DOM 诊断虽记录该 presentation revision，仍未与产生它的 session revision/按键事件建立关联。

编辑器也有已确认的独立缺口：`ConversationComposer` 在 non-activating 模式的 `onPointerDown` 调用 `preventDefault()`，阻止 DOM selection 更新，却没有从该次 pointer 坐标计算并写入 adapter 的逻辑 selection。因而逻辑 selection 可能保留先前值；这是编辑器输入状态来源问题，不应由候选窗口或 Rime 状态修补。

## 提案

### 保留进程边界，统一协议而非引入全局 store

保留 native helper、main、renderer editor 和 candidate renderer 的职责边界。`ImeSessionManager` 继续是引擎及 lease 的 main 权威；renderer session client 是只读投影；`imeInputTargetCoordinator` 管 renderer 本地目标和顺序；文本 adapter 管逻辑编辑位置；candidate renderer 不写权威候选内容。

禁止组件或 hook 复制 `generation`、engine composing、候选数组、活动 target 等权威状态作为另一份可独立改变的状态。局部派生值可以存在，但必须可从 owner 快照纯计算。

### 先立跨边界可验证契约

- candidate snapshot 携带其来源的 main session revision；candidate renderer 对同 owner/generation 的较旧 revision 不得覆盖较新 revision。clear/suspend 也必须带足够的 owner/generation/revision 身份，避免迟到 clear 隐藏新候选。
- 按键处理结果、session snapshot 和候选 presentation 通过同一处理序号或明确映射关联。若 native `eventId` 跨进程复用，需定义其唯一范围和回绕规则；不得仅凭时间戳或 UI 观感猜测关联。
- main 只有在 Rime 命令完成后使用对应 manager snapshot 构造候选投影。renderer 提供候选 anchor，不得提供/回写引擎候选事实。
- 先用纯 reducer/协议测试证明旧 revision 的 show/clear 都被拒绝，再接入真实 IPC。没有证明当前存在乱序覆盖之前，不将新增 revision 字段宣称为旧词条问题的根因修复。

### 让逻辑 selection 有可靠输入来源

隐身编辑器保持 DOM 不获焦；pointer down 的坐标必须经同一编辑器 adapter 的纯测量/映射函数转换为逻辑 selection，再启动或保持输入 lease。不能再等待失焦 DOM 的 `selectionchange` / `select` 事件来提供可信位置。先为单行/多行、滚动、缩放与组合文本建立测试边界；无法测量的布局应明确返回不可用，而非回退到开头或猜测 offset。

### 把焦点观测与状态管理分开

对 focus-probe blur 记录 timestamp、probe window/document 标识；对 main/native 记录 foreground HWND/PID、Answra owner HWND、candidate HWND、lease generation、candidate show/hide 与 hook start/stop 时间。关联字段只用于诊断，不得用候选窗 `focused:false` 代替外部 probe 验收，也不允许在缺少系统观测时推断因果。

### 分阶段收敛，不做一次性重写

1. **边界基线**：为状态 owner 表的每一项找到 writer、reader 和当前失效机制；如果与既有 Note 冲突，先修正文档或标记旧决定不再适用。
2. **候选链路**：建立带 revision 的 candidate snapshot 契约与过期状态测试；确认同一 revision 从 main 到 renderer 的接收和 DOM 实际渲染一致。
3. **编辑器 selection**：抽出并测试 pointer 坐标到逻辑 selection 的纯逻辑，随后接入 composer；验收 DOM `focus/blur` 计数为零以及中间点击后的插入、退格、左右移动。
4. **焦点归因**：建立 probe 与 OS foreground 的关联日志和可复现实机步骤；只在证据指向的层修复。
5. **减负评估**：每阶段检查是否仍有双写状态、无法证明的边界或维护成本。若最小输入闭环不能稳定验收，优先关闭/删除隐身 IME，而不是继续扩展能力。

每一阶段都单独变更、单独测试、单独 Note 状态迁移；禁止把协议、selection、hook 策略和候选 UI 同时改写成一个大 patch。

## 曾考虑的替代方案

- **把所有状态迁入 Zustand/Redux：** 不采用。native、main、主 renderer、独立候选 renderer 不共享同一 JavaScript heap；单 renderer store 会引入多个镜像 store，并不提供跨进程原子性，反而增加复制和同步代码。
- **立即重写/删除整套 IME：** 暂不决定。当前代码已有 main-owned session、generation/revision、typed IPC 和 renderer target coordinator 等可复用边界；尚未证明最小输入链路无法隔离修复。若按本提案分段后仍不能建立可验收闭环，则删除/禁用隐身 IME 是优先替代方案。
- **只给 candidate snapshot 加 revision 后宣布修复：** 不采用。版本字段能使迟到状态可拒绝、可诊断，但目前没有证据证明旧词条现象由该竞态导致；仍需端到端测试和实机复现。

## 验收标准

- 可观察结果：每项权威状态有且仅有一个 writer；候选窗收到并渲染的版本与 main 当前版本一致，旧版本不能覆盖/清除新版本；隐身 pointer 操作更新逻辑 selection 且 DOM 焦点事件保持零；blur 与系统前台变化能在同一时间线对照。
- 自动化验证：候选快照过期 show/clear reducer 测试；IPC 来源/generation/revision 测试；pointer 至 selection 的纯函数与组件测试；文本插入/退格/移动 selection 测试；目标控件 `focus` / `blur` 零调用断言。
- 需要的实机验证：Windows 10/11 目标版本下，隐身开启时非激活输入、候选逐键更新、候选选择后下一轮候选更新、文本中部点击编辑、focus-probe 是否 blur；分别记录系统版本、构建和日志证据。自动化与 typecheck 不算实机通过。

## 风险

- revision 能检测和拒绝过期展示，但若上游没有生成新 engine snapshot、候选窗口被系统遮挡或 Rime composition 本身未更新，它不能修复那些根因。
- pointer-to-caret 的几何测量受字体、换行、缩放、滚动和平台排版影响；不确定布局必须显式失败，不能静默回退。
- focus-probe 的 blur 可能由其他系统窗口/输入法/应用切换引起；必须记录 OS foreground 身份，避免将相关性误写成因果。
- 工作区当前有多项用户未提交变更；实施阶段只改 IME 范围文件，保留 staged/unstaged 的既有内容，不提交、不推送。

## 实施进度（2026-10-28）

已完成 renderer 输入协调器的第一阶段收敛：`imeInputTargetCoordinator` 现在拥有明确的 `idle`、`active`、`disposed` 生命周期、单调 `eventId`、单调 target epoch 和统一的串行队列。target 切换、释放或销毁后，排队中的旧操作会在执行前被丢弃；`useEmbeddedIme` 在异步结果回写前再次校验 target epoch 与 lease generation。

本阶段只证明输入队列不会把旧 target 或旧激活周期的结果继续写回当前编辑器，尚未证明中文输入、候选内容刷新、逻辑光标、退格或系统 focus 行为已修复。对应测试为 `packages/ui/test/imeInputTargetCoordinator.test.ts` 以及既有 IME transaction 测试；Windows 非激活实机验证仍待完成。
## 当前工作区审查记录（2026-10-28）

本轮只完成代码职责与规模盘点，尚未完成模块拆分，也没有把候选旧词条、光标或 focus-probe blur 标记为已修复。当前文件规模与主要职责如下：

| 文件 | 行数 | 当前职责混合 | 既有测试 |
|---|---:|---|---|
| `apps/desktop/src/main/ime/imeIpc.ts` | 1008 | IPC 注册/来源校验、lease 生命周期和窗口监听、native keyboard capture 转发、session command 执行与去重、renderer diagnostics 过滤 | `apps/desktop/test/imeIpc.test.ts`，覆盖租约、命令、捕获、焦点和诊断 |
| `apps/desktop/src/main/ime/imeCandidateWindowController.ts` | 785 | 候选事实写入、owner/window 生命周期、候选窗口创建、锚点到屏幕几何、可见性/层级、状态与动作 IPC、原生窗口诊断 | `apps/desktop/test/imeCandidateWindowController.test.ts`，覆盖布局/生命周期/动作/尺寸/锚点 |
| `packages/ui/src/hooks/useEmbeddedIme.ts` | 775 | React 订阅、target/lease 生命周期、按键串行队列与路由、候选动作、文本 fallback 和诊断 | `packages/ui/test/useEmbeddedIme.test.tsx`，覆盖队列/路由/租约/快照/候选动作 |

拆分必须保持现有 Note 中的单一 IPC 写入口、main-owned session 和候选 controller 单写边界，不新增第二套 store、不改跨进程行为。拆分按低风险、边界清楚的职责逐步进行：第一步把 renderer 诊断频道的来源校验、字段白名单与日志投影从 `imeIpc.ts` 抽为独立诊断入口，原 IPC 来源校验仍在入口完成；第二步再以显式依赖切分 session command 执行/去重与窗口 lease/native capture 生命周期。`registerImeIpc` 保持唯一 session IPC 组合根和写入口，不新增 store 或平行领域频道。每一刀先定义依赖接口和测试范围，再做行为保持的搬移，禁止用更小但职责不清的新文件凑行数。

第一步已实施：`imeRendererDiagnostics.ts` 负责候选 renderer/owner renderer 诊断来源判断、payload 白名单验证与日志字段投影；`imeIpc.ts` 仍持有唯一频道注册和 sender-to-window resolver，并注入这些依赖。新增独立测试覆盖可信来源、target 白名单、敏感字段不投影、默认日志降噪及候选 renderer 来源限制。此拆分不改变 session lease、Rime 状态或用户输入行为。桌面定向测试 36 项通过，desktop typecheck 通过；Windows 行为未在本次验证。

当前工作区的候选 presentation `revision` 试验已补齐必填共享契约、诊断入口数字校验，并增加候选 renderer 新状态后拒绝旧状态的回归测试；desktop/UI typecheck 与候选 renderer、candidate controller、candidate IPC 定向测试通过。它仍不带 main session revision 或 native key event correlation，不能据此宣称用户报告的旧候选问题已修复；Windows 端到端验证仍缺。

本轮未提交、未推送；工作区另有其他未提交变更，审查与后续拆分必须逐文件保留，不整体回滚。
## 本轮定位：候选实际渲染日志去重范围过窄

对“候选提交后再输入仍显示旧词条”的定位先修复观测缺口，不把观测修复描述成输入功能修复。`ImeCandidateWindowApp` 在 DOM 更新后发送包含 preedit、候选文本、selectedIndex 与 page 的 `candidate-rendered`；但 main 侧 `logImeDiagnostic` 的去重签名只包含 generation、几何、可见性与样式。于是同一轮 lease 内候选内容变化而布局不变时，确实渲染的新状态日志会被丢弃，无法比较候选窗 DOM 与其接收的 snapshot。

决定：去重签名必须纳入 target、preedit、候选文本、selectedIndex、page 和展示几何/可见性。补回归测试，证明相同布局下候选内容变化会输出新日志；重复的相同展示仍去重。此改动只提高诊断完整性，不证明也不修复候选内容卡住；根因仍须用端到端状态时间线或 Windows 实机日志判断。

验证：代码改动后执行 desktop `imeDiagnostics` 定向测试与 typecheck。替代方案是移除渲染日志去重，但会在 RAF/布局重渲染时高频打印相同状态，故保留去重并扩大其语义键。

