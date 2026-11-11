# Note：声明式浮窗系统 P0（产品预设 + 独立窗口）

状态：已实施

## 问题

产品缺少一个可复用的浮窗载体：确认、引导或临时说明若塞进共享面板，无法独立拖动、独立关闭，也无法在不抢焦点的情况下展示。

本轮目标不是一次做完 Agent 生成界面，而是先落地提案中的 P0：一份共享的声明式 Spec、一个独立浮窗窗口和固定原语渲染器。Agent 接入、窗口池、预设持久化和槽位覆盖仍留在后续阶段。

最初把面试「清空」确认接到浮窗，但该入口不属于本轮需求，且实机反馈确认浮窗在隐身状态下不可可靠点击，已撤销产品接入；面试清空恢复为直接执行。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/surfaces/spec.ts`、`packages/shared/src/surfaces/index.ts`
  - `packages/shared/src/channels/surface.ts`、`packages/shared/src/channels.ts`
  - `packages/shared/src/bridge.ts`、`packages/shared/src/index.ts`
  - `apps/desktop/src/main/surface/`（controller、service、presets、state store、IPC）
  - `apps/desktop/src/main/window.ts`、`windowSurfaceRegistry.ts`、`index.ts`
  - `apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/main.tsx`
  - `packages/ui/src/surfaces/`、`packages/ui/src/app/InterviewFeaturePanel.tsx`
  - `packages/ui/src/components/panels/InterviewCapturePanel.tsx`
  - `packages/ui/src/components/controls/SurfaceButton.tsx`
- UI/进程/协议/持久化表面：
  - 新增独立 `surface` 原生窗口角色与 `answra:surface:*` 频道
  - 新增 `DesktopBridge.showSurface / onSurfaceState / requestSurfaceState / dismissSurface / sendSurfaceAction / fitSurface / onSurfaceAction`
  - 仅在 `appData/Answra/surfaces/state.json` 持久化窗口位置；不持久化卡片正文
- 相关 Note：
  - [声明式浮窗系统提案](../../proposed/architecture/2026-11-11-declarative-surface-system.md)
  - [原生窗口生命周期与共享策略注册](../../implemented/architecture/2026-10-14-window-surface-lifecycle.md)
  - [悬浮表面视觉契约](../../implemented/architecture/2026-10-11-floating-surface-visual-contract.md)
  - [面试演练与面试记忆](../../implemented/feature/2026-11-10-interview-rehearsal-and-memory.md)

## 决定

### 1. 共享 Spec 是唯一内容契约

`SurfaceSpec` 只允许固定原语：`stack`、`text`、`button`、`list`、`progress`、`divider`。主进程和渲染器都通过 `parseSurfaceSpec` 校验：

- 节点数不超过 64、嵌套不超过 6 层、总文本不超过 2000 字符、动作不超过 6 个。
- 按钮的 `actionId` 必须在 `actions` 中声明。
- `list` 项文本必须唯一，渲染器用文本作为稳定 key。
- 首版不提供 `input`：隐身状态下窗口不可聚焦，先不引入文字输入这一未验证边界。

动作只允许 `dismiss`、`open-panel`、`send-message`、`invoke`；浮窗渲染器只上报 `actionId`，不直接执行动作。

### 2. 一个独立 `surface` 窗口

`surfaceWindowController` 复用了回复窗的窗口模式：无边框、透明、`skipTaskbar`、`showInactive()`、显示前 `prepareWindowToShow()`、捕获保护 `stealth-only`、`failClosed`。窗口在 `windowSurfaceRegistry` 中登记为 `surface` 角色：

- 非隐身时普通可聚焦窗口，隐身时随 `stealth` 策略变为非激活。
- 位置优先读取 `state.json`，否则在主屏居中；拖动后防抖持久化。
- 尺寸由渲染器测量后上报，主进程只做 clamp；渲染器不直接改窗口。
- 生命周期支持可选 `ttlMs`；首版产品预设不使用自动消失。

### 3. 产品接入已撤销

曾把面试「清空」接到 `interview.clear-confirm` 预设，验证按钮、动作白名单、动作回传和产品代码响应。实机反馈发现：

- 该入口不是本轮需求，给清空增加独立浮窗扩大了改动面。
- 隐身状态下浮窗点击不可靠，用户无法完成清空。

因此撤销 `InterviewFeaturePanel` 与 `InterviewCapturePanel` 的浮窗接入，清空恢复为只执行原 `onClear`。`surfacePresets` 中的预设和底层窗口能力暂时保留但没有任何产品入口，后续必须先有独立需求与实机验证再接入。

### 4. 明确未做

- 没有任何产品入口；面试清空保持直接执行，不经过浮窗。
- 没有 Agent 工具或 `SurfacePort`；P2 再接入。
- 没有窗口池、队列和淘汰；当前同一时间只有一个 surface 窗口。
- 没有用户预设、槽位覆盖、预览/应用/回滚。
- 没有把浮窗正文写入磁盘或审计日志。
- 没有替换 `FloatingLayerHost`；条内通知仍走原路径。

## 模块边界

- `packages/shared/src/surfaces/`：只放 Spec schema、校验、原语类型和预设 id；不渲染、不持窗口状态、不写文件。
- `packages/shared/src/channels/surface.ts`：只放频道与载荷类型；不实现业务动作。
- `apps/desktop/src/main/surface/`：唯一信任边界，负责预设解析、Spec 校验、窗口、位置、动作查表与 IPC；不渲染 DOM。
- `packages/ui/src/surfaces/`：只把合法 Spec 渲染成固定原语并上报动作 id；不校验权限、不持久化、不决定产品语义。
- `apps/desktop/src/main/windowSurfaceRegistry.ts`：继续作为所有原生窗口策略的唯一登记点；`surface` 角色不得绕过它。
- `packages/ui/src/app/InterviewFeaturePanel.tsx`：只负责面试会话、发送和清空；不发起浮窗。
- `FloatingLayerHost`：继续服务条内瞬时通知和权限提示，不与独立浮窗合并。

## 曾考虑的替代方案

- **把清空确认塞进现有面板或 `FloatingLayerHost`：** 舍弃。清空不需要额外确认载体；实机验证表明浮窗入口反而破坏原流程，已回退为直接清空。
- **本轮直接做 Agent 生成浮窗：** 舍弃。Agent 接入需要端口、worker 帧、动作回传和旧 run 失效策略；先把 Spec、窗口、隐身和动作链路验证清楚，再放大生成能力。
- **首版就做窗口池：** 舍弃。当前没有产品消费者，池化会提前引入队列、淘汰、多窗口 z-order 和位置恢复的复杂度；单窗口足以证明契约。
- **允许 AI/产品传 HTML 或自定义 React：** 舍弃。会引入代码执行、CSP、样式漂移和不可测试性；固定原语 + 白名单动作是安全边界。
- **把浮窗位置和 Spec 一起持久化：** 舍弃。Spec 可能包含用户资料或临时内容；P0 只持久化位置，正文只在内存和当前会话中。

## 后果与防回退

- 新增原生窗口必须登记 `surface` 角色并走 `prepareWindowToShow`；`pnpm architecture:check` 会在缺少 `registerWindowSurface` / `prepareWindowToShow` 时失败。
- 所有浮窗内容必须经过 `parseSurfaceSpec`；渲染器不得新增 `dangerouslySetInnerHTML`、iframe、远程 URL 或任意 CSS 入口。
- 浮窗渲染器只上报 `actionId`，主进程按当前 Spec 查表；不要改成让渲染器上报完整动作对象，否则信任边界会回到渲染进程。
- 新增原语必须同时更新 schema、渲染器、限制和测试；`list` 文本唯一性目前是隐式契约，改回索引 key 会破坏复制/移动时的稳定渲染。
- 当前动作失败（产品没有处理转发动作）会关闭浮窗并丢弃结果；后续若需要重试或阻塞确认，先补协议 Note，不要在 UI 里自行等待。
- 隐身状态下 Windows 非激活窗口的点击与拖拽尚未实机验证；在完成验证前，不得对外宣称“隐身时完整可交互”，也不得把浮窗接入任何破坏性操作。
- 面试清空必须保持直接执行；如需重新引入确认，必须单独立项并先证明隐身窗口可交互，不得复用本轮撤销的接入方式。
- 若后续引入窗口池或 Agent 持久化，必须更新本 Note 和提案，不能把未实现能力写成已交付。

## 验证

- 自动化已通过：
  - `pnpm --filter @answra/shared test`：Spec 接受/拒绝、节点/深度/文本/动作预算、未声明动作、非法 panel。
  - `pnpm --filter @answra/ui test`：原语渲染、动作回传、非法 Spec 忽略、Esc 关闭。
  - `pnpm --filter @answra/desktop test`：窗口角色登记、渲染器/ready-to-show 握手、尺寸 clamp、关闭隐藏、位置持久化、IPC 发送方与载荷校验。
  - `pnpm typecheck`、`pnpm exec biome check .`、`pnpm architecture:check`、`pnpm tokens:check`。
- 需要的实机验证（尚未完成）：
  - Windows 11 开启隐身后，浮窗能否点击「清空/取消」并拖动；不能则记录表现并决定是否改为手动拖拽 IPC。
  - 多显示器拖动、显示器移除后的位置恢复。
  - 全屏会议窗口上的层级与捕获保护表现；只能陈述 Electron 内容保护已启用，不能承诺所有录屏工具不可见。
