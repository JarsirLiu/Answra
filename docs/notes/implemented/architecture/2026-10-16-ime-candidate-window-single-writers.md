# Note：IME 候选窗 controller 事实域拆分（S3）

状态：已实施

## 问题

S2 收口了 renderer 侧（[S2a](2026-10-16-ime-renderer-single-writer-facts.md)）与候选锚点 reporter（[S2b](2026-10-16-ime-candidate-anchor-single-writer.md)）的状态副本，但主进程的候选窗 controller 仍是**单一写入批次**：`imeCandidateWindowController.ts` 用一组模块级 `let` 同时持有引擎候选状态、锚点几何、owner/target/generation 与窗口引用。

这带来三个具体缺陷：

1. **事实域互相夹带**：`hide()` 一次清空 owner、候选状态、锚点、target/generation 五个域；`suspend()` 复用 `hideWindow()` 却只清锚点；`setOwner()` 的 `targetId`/`generation` 与 `state` 是三个平行变量，任何一处漏清都会让"当前候选属于哪个 generation"失真。
2. **展示与生命周期混写**：`positionAndShow()` 在算位置时顺带决定 show/层级/尺寸/可见性；`createWindow()` 同时注册捕获保护 + `attachAbove`；`reportNativeWindow()` 把捕获保护诊断与几何塞进同一 payload。
3. **sizing 没有契约**：`resize()` 是唯一写入者，但默认 `INITIAL_SIZE 640x56` 只是占位常量，非法尺寸被静默忽略，没有回归断言。

这正是 [可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md) 中"状态有多个写入者"在主进程一侧的最后一处，也是该提案 S3 的唯一目标。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeCandidateWindowController.ts`；测试 `apps/desktop/test/imeCandidateWindowController.test.ts`。
- UI/进程/协议/持久化表面：仅 main 候选窗 controller 的内部写入者结构；不新增 IPC 频道、不改 `ImeCandidatePresentationUpdate` 契约、不改窗口层级或捕获保护行为、不动 renderer/Rime/持久化。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[统一 IME 输入目标与窗口生命周期](2026-10-15-unified-ime-target-lifecycle.md)、[候选锚点/窗口面副本收口（S2b）](2026-10-16-ime-candidate-anchor-single-writer.md)。

## 决定

把候选展示事实拆成**每个域一个写入者**，`hide`/`suspend` 只对各自域组合调用，不再共用一个批量赋值块：

1. **候选内容**（`content: { state, targetId, generation }`）：把原来平行的 `state`/`targetId`/`generation` 三个变量合成一个不可变值，唯一写入者 `setContent`/`clearContent`。identity 与 state 从此不可能分叉；`matchesCandidate` 与 `routeAction` 都只读 `content`。
2. **锚点**（`anchor`）：唯一写入者 `setAnchor`/`clearAnchor`。`suspend` 只清锚点、保留 `content` 与 owner 绑定，`hide` 才清全部——两者不再共用赋值块。
3. **窗口生命周期**（`windowRef`/`pageLoaded`/`rendererRequestedReady`/`rendererReady`）：唯一重置入口 `resetWindowLifecycle`（`createWindow`、`closed`、`dispose` 三处复用）。
4. **owner 绑定**（`ownerWindow` + closed/move/resize 监听 + z 序）：唯一写入者 `bindOwner`/`unbindOwner`；`unbindOwner` 负责移除监听并清引用。
5. **sizing**（`size`）：唯一写入者 `setSize`（对外仍是 `resize`），非正/非有限尺寸直接忽略并保持上一次有效值——把"尺寸只能是 renderer 上报的未裁剪内容尺寸"这条契约固化为单一写入点。
6. **捕获保护**：保持只在 `createWindow` 通过 `host.registerWindowSurface` 注册一次，不在别处改写。
7. **位置与可见性/层级分离**：`positionAndShow` 拆成三件事——`computeCandidateFrame`（只解析 owner→anchor→work area 几何，绝不改可见性或 z 序）、`applyCandidateGeometry`（唯一 `window.setBounds` 写入者）、`presentCandidate`（唯一 `showInactive`/`attachAbove` z 序写入者）；隐藏仍只由 `hideWindow` 写。展示失败（renderer 未就绪、无锚点、下方无空间）不再夹带任何几何或层级写入。

导出 API（`dispose`/`isCandidateContents`/`resize`/`routeAction`/`warmup`/`markRendererReady`/`sendState`/`update`/`getWindow`）与外部可观察行为不变。

本阶段**不**做：不拆 `readOnly` 双职责（第 2 项，留 S5）、不合并 `imeIpc` 双入口（第 3 项，留 S4）、不动候选窗主题第二套推导（第 5 项）。

## 模块边界

- controller 仍是候选窗生命周期、锚点定位、层级与捕获保护的唯一所有者；它只把候选状态与锚点当作输入事实拆分持有，不拥有或改写 Rime 引擎状态。
- 每个事实域只允许经由上表列出的 writer 变更；新增行为必须先确定其唯一 writer，禁止直接对域变量赋值。
- `ImeCandidatePresentationUpdate` 契约不变，renderer/main 调用方无需感知本次拆分。

## 曾考虑的替代方案

- **把 controller 拆成多个对象/文件（如 WindowLifecycle + ContentStore + AnchorStore）：** 舍弃为本次手段。提案硬性标准明确"拆成多个对象只有在同时消除状态副本或写入者时才计为进度"；单纯挪进子对象只是换命名空间。因此本次改为在单文件内确立每个域的唯一 writer，并真正消除 `state`/`targetId`/`generation` 的三份平行副本。
- **只补日志、不动写入者结构：** 舍弃。日志只能记录结果，不能阻止 `hide`/`suspend` 继续共用批量赋值；下一个改动仍可能只清一半域。
- **让 `suspend` 也清空 `content` 与 owner 绑定：** 舍弃。`suspend` 语义是"窗口暂时失焦、composition 与目标仍属于原 owner"，清空会让恢复时无法判断迟到候选属于哪个 generation；`hide` 才是释放。
- **给 `setSize` 增加尺寸上限钳制（clamp 到 work area）：** 本次暂缓。上限已由 `positionImeCandidate` 在布局阶段按 display work area 施加，controller 侧再加一层会形成第二个尺寸裁剪写入者，与"单一写入者"相悖；留待 S4 统一尺寸契约时决定。

## 后果与防回退

- 不得再引入与 `state`/`targetId`/`generation` 平行的候选副本；候选身份只能来自 `content`。
- `suspend` 不得改为清 `content` 或解绑 owner；`hide` 不得改为保留 `content`。二者语义差异由测试锁定。
- `setSize` 必须继续拒绝非正/非有限尺寸并保持上一次有效值；若将来要钳制，只能在布局层做，不要在 controller 引入第二个尺寸写入者。
- 有意接受的代价：`content` 为不可变值，`setContent` 每次展示都会替换对象；这与候选更新频率（按键级）匹配，不做就地修改优化。
- 尚未消除的耦合：`reportNativeWindow` 仍把捕获保护诊断与几何放在同一 payload——属后续改造，不因本次拆分误认为已完成。

## 验证

- `apps/desktop/test/imeCandidateWindowController.test.ts`（原 7 项 + 新增 2 项，共 9 项）：
  - 新增「suspend 只清锚点」：`suspend` 后窗口隐藏但 `owner.move` 监听仍在（owner 绑定保留）；此时旧 generation 的 `clear` 被忽略、匹配 generation 的 `clear` 仍生效（证明 `content` 未被 suspend 清掉）；随后 `clear` 释放 owner 绑定（`owner.move` 监听归零）。
  - 新增「非法尺寸被忽略」：`resize({ width: 0, height: -4 })` 不产生 `candidate-native-positioned`，窗口保持 640x56，证明 `setSize` 是唯一且守约的尺寸写入者。
  - 原有 7 项（几何/路由/尺寸/锚点焦点/owner move/预热/瞬时空状态）全部保持通过，证明外部行为不变；其中「owns candidate window geometry」「repositions when its owner moves」「reports the renderer-requested size」三条同时覆盖 `computeCandidateFrame`→`applyCandidateGeometry`→`presentCandidate` 的几何与可见性路径。
- 门禁：`pnpm verify` 全绿（Biome、Note 门禁、全包 typecheck、UI 168、desktop 150、app、architecture check）。
- 需要实机验证（S5）：Windows/macOS 下 suspend/hide/owner 移动时的候选窗层级与位置、捕获保护表现。
