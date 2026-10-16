# Note：IME renderer 侧状态副本收口（S2a）

状态：已实施

## 问题

2026-10-16 的三个 IME 故障（Shift 后输入锁死、FFI 解码崩主进程、候选窗宽度棘轮）复盘后确认：找不到问题不是"缺抽象"，而是**焦点/lease/模式事实在 renderer 有第二份和第三份副本**——

- `useEmbeddedIme` 同时持有 `focusedRef`（自己的焦点副本）、`generation`/`generationRef`（自己记的租约代号）、`asciiMode`/`asciiModeRef`（自己记的模式）、`targetEngaged`（乐观置位的"已取得租约"）；
- `imeInputTargetCoordinator` 又维护一份模块级 `activeTarget`；
- DOM `activeElement` 与 main 的 `owned/suspended` 各自还是权威。

这几份副本由不同事件流更新（快照回调、DOM focus/blur、window focus/blur、命令结果），一旦顺序不同就会给出互相矛盾的判断：例如 lease 已被 main 撤销而 hook 仍认为自己持有（按键被吞），或 lease 仍属于本 target 而 hook 已放弃路由（编辑器和引擎同时行为）。日志只能记录"结果"，无法回答"这次是谁改的"。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/ime/imeSessionClient.ts`、`packages/ui/src/ime/imeInputTargetCoordinator.ts`；`packages/shared/src/channels.ts`（诊断字段名）、`apps/desktop/src/main/ime/imeIpc.ts` 与 `imeDiagnostics.ts`（字段转发/格式化）、`apps/desktop/test/imeIpc.test.ts`、`packages/ui/test/useEmbeddedIme.test.tsx`。
- UI/进程/协议/持久化表面：renderer 内部状态所有权与 renderer 诊断字段；不新增 IPC 频道、不改 main 的 session 语义、不改 Rime、不改持久化。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[IME 租约释放原因与默认焦点链日志](../bug-fix/2026-10-16-ime-release-cause-diagnostics.md)、[IME 输入目标 blur 与窗口失焦顺序](../bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md)、[Shift 输入锁死](../bug-fix/2026-10-16-ime-shift-ascii-input-lockout.md)、[编辑器可编辑性策略（已否决）](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)。

## 决定

按事实域给出唯一写入者，renderer 组件只派生、不缓存：

1. **引擎与租约事实**（模式、composition、候选、owner、generation）只由 main 写；renderer 侧唯一 store 是 `imeSessionClient` 的 `latestSnapshot`。
2. **renderer 活动输入目标**（"本 renderer 当前接受键盘输入的是哪个 target"）唯一由 `imeInputTargetCoordinator` 写，并作为可订阅外部快照暴露。
3. **DOM 焦点**不再被任何模块缓存，只在需要时按需读取（诊断字段、`confirmFocus` 前置判断）。
4. **用户意图**（`imeEnabled`）仍是 hook 本地 state，它是 UI 意图而不是事实。

具体落地：

- `imeSessionClient` 增加 `subscribeImeSessionSnapshot`，并在 `publishImeSessionSnapshot` 通知订阅者；新增派生 getter `getImeOwnedGeneration(targetId)`、`isImeTargetOwned(targetId)`、`getImeInputMode()`、`getImeComposing()`，取代"hook 自己记 generation/asciiMode"。
- `imeInputTargetCoordinator` 暴露 `getActiveImeInputTargetId()` / `subscribeImeInputTargets()`（字符串快照，值不变即身份不变），激活与注销时通知。
- `useEmbeddedIme` 用两个 `useSyncExternalStore` 取代五处本地副本：`state` = 本 target 拥有 lease 时的 `snapshot.engine`，否则空状态（保留全局 `inputMode`）；`generation` = `snapshot.owner.targetId === targetId ? owner.generation : undefined`（含 suspended，与旧 `generationRef` 语义一致）；`asciiMode` = 全局 `inputMode === "ascii"`；`targetEngaged` = `targetRegistered || (ownsLease && phase === "owned")`；`targetRegistered` = coordinator 快照。
- `blur()` 现在会注销 coordinator 注册：注册是本 renderer 自己的事实，落它即可停止在途与后续按键；租约仍留在 main，恢复焦点走 `confirmFocus()`。这取代了旧的 `focusedRef=false`。
- 新增"注册不得比 lease 存活更久"规则：当 main 报告 session 空闲或归他人且当前没有 acquire 在途时，hook 注销注册，按键回落给编辑器而不是被吞掉。
- acquire 被拒或焦点在 acquire 期间丢失时显式注销注册（原先只清 `targetEngaged`，会让 coordinator 长期停在"已注册但无 lease"）。
- 诊断 wire 字段 `focusedRef` → `targetRegistered`（shared 类型 + comment、main 白名单字段名、`imeDiagnostics` key-routing 输出、desktop 测试）；语义改为"coordinator 是否仍注册本 target"。诊断里的 `activeElementTarget`（DOM）保持独立字段，两个事实不再互相冒充。
- 删除已无消费者的 `getImeSessionRevision`（revision 只属于 client 内部）。

本阶段**不**做的事：不改 main 的 lease/suspend 语义，不动候选窗与窗口面（S3），不删除 `readOnly` 与系统 IME 隔离（平台未验证），不改变 `imeEnabled` 的本地 state 性质。

## 模块边界

- 事实与写入者一一对应（本 Note 的核心边界）：
  - 引擎/租约/模式/composition → main `ImeSessionManager`，renderer 只读 `imeSessionClient` 快照；
  - renderer 活动输入目标 → `imeInputTargetCoordinator`；
  - DOM 焦点 → DOM 本身，renderer 不缓存；
  - 编辑器文本与 selection → 各 editor adapter；
  - UI 意图（IME 开关）→ hook 本地 state。
- `imeSessionClient` 只承载 session 协议客户端职责（快照存储、revision、typed command 信封、订阅）；它不得加入焦点概念。
- `imeInputTargetCoordinator` 只登记唯一活动 target 并串行化 renderer 输入 FIFO；它不得复制 lease/模式/焦点。
- `useEmbeddedIme` 只做派生与转发，不得再引入任何事实副本；新增行为前先确认"这个事实的写入者是谁"。
- `packages/shared` 的诊断类型字段名是 wire 契约，改名必须同时改 main 转发与测试。

## 曾考虑的替代方案

- **保留 hook 本地副本，只把日志补齐（停在 S1）：** 舍弃。S1 让故障可读，但"谁改的"仍然只能靠推断；副本之间的顺序问题会在下一次改动里复现。
- **把 `asciiMode`/`generation` 搬进 React context：** 舍弃。context 只是换了个存放位置，仍然是第二份可被写坏的事实；也没有回答"main 撤销后 renderer 何时放弃路由"。
- **用 coordinator 的注册状态同时门控 `readOnly`（即 `targetEngaged = targetRegistered`）：** 舍弃。DOM blur 会注销注册而 lease 仍属于本 target，`readOnly` 会在那一刻放开，重新出现"ASCII 模式下元素变成原生文本目标"的 Shift 锁死路径。因此保留 `targetEngaged = 注册 || 拥有 lease`，让"已拥有 ⇒ 恒只读"这条防回退约束继续成立。
- **让 `sendKey` 直接以 `owner.targetId === targetId`（lease）为唯一门控：** 舍弃。acquire 尚未 resolve 时的按键必须仍被 IME 接管（既有回归测试），而那时还没有 lease；用注册状态表达"本 renderer 已认定这是活动目标"才准确。
- **保留 `focusedRef` 但把它当成派生缓存：** 舍弃。派生缓存仍然需要同步时机，正是顺序问题的来源；改为按需读 DOM 或读 coordinator 快照后，不再存在"两个事实不同步"的窗口。
- **把不变量写成文档约定而不写测试：** 舍弃。副本回归是静默的，本阶段把三条关键语义写成回归测试（跟随 main 撤销、blur 后丢弃在途回复、owned 期间 blur 仍锁原生输入）。

## 后果与防回退

- renderer 组件不得再持有 `asciiMode`、`generation`、`targetEngaged`、焦点或"我是否拥有 lease"的副本；需要时从 `imeSessionClient` / `imeInputTargetCoordinator` 派生。新增第二处本地 state 视为架构回退。
- `targetEngaged = targetRegistered || (ownsLease && phase === "owned")` 是"已拥有 ⇒ `readOnly`/`blockNativeEditing` 恒真"的实现方式，不得改成只依赖 coordinator 注册。
- 注销注册（coordinator）与释放租约（main）是两件事：blur 只注销注册；只有显式 `release`/命令失败/main 撤销才影响租约。任何"blur 即释放租约"的改动都会推翻 [blur/失焦顺序 Note](../bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md) 的结论。
- 新增 renderer 事实前必须先指定唯一写入者；跨进程事实一律以 main 快照为准，不允许用 renderer 本地状态解释 main。
- 诊断字段语义：`targetRegistered` 描述 coordinator 注册，`activeElementTarget` 描述 DOM 焦点，`documentHasFocus` 描述窗口活跃；三者不得合并成单一布尔值，否则又会退化成"无法判断是谁改的"。
- 有意接受的代价：真实切换顺序下（新 hook 先 `activateImeInputTarget` 覆盖旧 target）`release("target-switched")` 基本不可达，旧 lease 由 main 的 `owner-replaced` 收口；仍然保留该路径以免切换时序变化时丢租约。

## 验证

- 自动化：`pnpm verify` 全绿（Biome、Note 门禁、全包 typecheck、UI 24 文件/162 项、desktop 26 文件/147 项、app 7 项、architecture check）。
- 新增/加强的回归测试（`packages/ui/test/useEmbeddedIme.test.tsx`）：
  - "follows a main-initiated revocation instead of trusting a renderer copy"：main 发布 `idle` 快照后，`generation` 归零、`targetEngaged` 归假、`readOnly` 放回原生、`sendKey` 返回 false 且不调用引擎；
  - "drops a queued key reply once the target is no longer registered"：blur 之后在途的按键回复不再触发 commit（原由 `focusedRef` 保证）；
  - "keeps native input blocked for an owned lease after the editor loses DOM focus"：DOM blur 后仍持有 lease 时 `useNativeTextInput` 仍为 false（防 Shift 锁死回退）；
  - "releases only its own lease when the hook unmounts"：改为断言 acquire 后未释放、卸载恰好释放一次（此前该用例实际走的是 acquire 拒绝路径，现已修正为真正覆盖卸载释放）。
- 需要用户实机验证：中文/英文输入、Shift 切换、对话面板与设置面板之间切换焦点后继续输入、切窗口回来继续输入、发消息后关闭应用（同时覆盖 `0ebf3d5` 的崩溃修复）。
