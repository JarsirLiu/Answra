# Note：预览缩放跟随视口尺寸变化（收起目录把空间让给正文）

状态：已实施

## 问题

用户收起目录后反馈：正文区左侧仍被一大片空白占据。根因是 `ZoomablePreview` 只在内容就绪（`fitSignal`）时适应一次宽度——缩放比例是按侧栏展开时的视口宽度算的；收起侧栏后视口变宽，没有任何机制跟随重适应，多出的空间变成预览两侧（尤其左侧）的空白。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/ZoomablePreview.tsx`、`WorkspacePanel.css`；新增 `packages/ui/test/zoomablePreview.test.tsx`。
- UI 表面：docx/pdf/图片/文本/markdown 等所有走 `ZoomablePreview` 的预览：视口尺寸变化时的缩放行为，以及正文区域的边界呈现。

## 决定

- 引入**适应模式**（`autoFitRef`，初始为真）：视口宽度变化（`ResizeObserver`）时自动重适应宽度；内容就绪（`fitSignal`）与「适应宽度」按钮都会恢复该模式。
- **手动缩放即退出适应模式**：缩小/放大/重置按钮置 `autoFitRef.current = false`，此后视口变化不再动用户的缩放值；再次点「适应宽度」恢复跟随。
- 观察器挂在内容容器上，回调只做模式判断 + `fitWidth()`（内部有 0 尺寸守卫）；`ResizeObserver` 每帧合并触发的特性天然防抖，不另加防抖计时器。
- **自然宽度由调用方给权威值（`fitWidthPx`）**：pdf 传 pdf.js 页面宽度、图片传 `naturalWidth`、docx 读 `.docx` 内联 `width`；不再量取渲染尺寸。无权威值（文本/markdown 自动折行）时「适应宽度」= 100%。
- **边界归属视口，不归属内容**：正文区域的框线（`1px --glass-line` 发丝线 + 小圆角）画在 `.zoomable-preview__viewport` 上，恒定可见、不随缩放与滚动移动；视口底色用 `--field`（灰底衬白纸），保证任何缩放下页边与框线都可辨认。内容顶左起排、宽度铺满视口，适配后正好贴满框内，不做居中对称留白。滚动只保留视口这一层（pdf/docx 宿主与 markdown 不再内嵌滚动条）。
- **正文贴边**：内容区、视口均为零内边距，页面/图片适配后直接贴到面板内沿（仅剩 1px 框线），不再有"纸外一圈空白"。误传/占位提示自带内缩。缩放工具条压成紧凑一行（按钮 `--ctl-h`，上下 `--space-1`）并居中，不再悬在下方。

## 根因

四层：

1. `fitWidth` 只由 `fitSignal` 驱动，而 `fitSignal` 只在渲染状态翻转时变化；侧栏收起只改变视口宽度，不触发任何重适应路径——缩放值停留在旧视口宽度算出的比例上。
2. 重适应若直接 `available / content.scrollWidth`，在 CSS `zoom` 下 `scrollWidth` 返回**已缩放**的布局宽度且被内容容器自身宽度钳制，除数含当前 zoom，每次适配都偏一档；配合滚动条出现/消失引发的连锁 resize，比例逐次爬升震荡。
3. 改为量取子元素 `getBoundingClientRect().width / zoom` 仍不可靠：该值与 zoom 的关系随渲染层实现漂移，实测每次重适应都让比例更小（72%→61%→41%），页面越缩越小、纸张四周的空白圈越来越大。
4. 边界曾画在 PDF 画布上（页边随内容走），配合 `margin: auto` 居中与多层内边距（内容区 12px + 视口 4px），页窄时出现"纸外一圈空白"；横向滚动时页边被框口裁掉，只能看到半条边线。
5. 观察器挂在内容容器上且不区分尺寸轴：缩放改变内容高度会再次触发观察器，形成自激循环（打开即疯狂闪动）；滚动条出现/消失改变视口可用宽度同理。

## 修复

- `ZoomablePreview` 挂 `ResizeObserver` 观察内容容器：适应模式下尺寸变化即重适应；手动缩放优先，`fitSignal` 与「适应宽度」可重新进入适应模式。
- 适配改为**确定性计算**：调用方通过 `fitWidthPx` 提供内容自然宽度的权威值（pdf.js `viewport.width`、`img.naturalWidth`、docx 页面内联 `width`），`fitWidth` 只做 `可用宽度 / 自然宽度`；完全不量渲染尺寸，缩放不再漂移。无权威值（文本/markdown）时「适应宽度」= 100%。
- **防自激闪烁**：观察器只看视口宽度，且宽度变化 < 1px 直接忽略——缩放会改变内容高度，跟随高度变化会形成"适配→高度变→再适配"的死循环（实机表现为打开文件后内容疯狂闪动）。视口加 `scrollbar-gutter: stable`，滚动条出现/消失不改变可用宽度，断掉"适配→滚动条→宽度变→再适配"的反馈环；`clampZoom` 改为向下取整到 1%，适配时页面不因四舍五入超出可用宽度而引出横向滚动条。
- 视口加常驻边框（`--glass-line` + `--ctl-radius-sm`）与画布底色（`--field`）；首版用 `--glass-line-soft`（黑 8%）在白纸旁不可见，用户反馈"看不到边界"，故升级为常规发丝线并加灰底衬白纸。移除内容居中（`margin: auto`）、移除 pdf 画布的假页边（边框/投影/圆角）与文本 pre 自身边框，避免双重框。
- 正文贴边：内容区与视口内边距归零，页面适配后直接贴到面板内沿（仅 1px 框线）；pdf/docx 宿主 `width: fit-content`，单层滚动；工具条压成紧凑一行（`--ctl-h` + `--space-1` 上下留白）并居中。

## 曾考虑的替代方案

- **收起/展开目录时由 `WorkspacePanel` 显式调用重适应：** 把预览的内部状态暴露给面板，多一条跨组件耦合路径；视口尺寸变化的来源不止侧栏（面板宽度、窗口缩放），观察者放在 `ZoomablePreview` 内部才覆盖全部来源，弃用。
- **resize 时无条件重适应、不区分手动缩放：** 用户放大到 200% 阅读时，收一下目录就被打断缩放，行为不可预期；保留手动优先级。
- **在内容容器上量 `scrollWidth`：** 容器铺满视口，`scrollWidth` 被容器宽度钳制，缩放后无法还原自然宽度（见根因 2），弃用。
- **量子元素 `getBoundingClientRect / zoom` 反推自然宽度：** 与 zoom 的换算关系随渲染层漂移，实测逐次收缩（见根因 3），弃用；改为调用方提供权威宽度。
- **纸张自带边框/投影的"浮动页"样式：** 页边随内容移动、滚动时被裁成半条，且与用户要求的"正文区域固定边界"冲突，弃用。

## 后果与防回退

- 约束一：视口尺寸变化必须触发重适应（适应模式下），新增会改变视口宽度的交互（如拖拽侧栏宽度）不得绕过该机制。
- 约束二：手动缩放退出适应模式的语义保持——程序化缩放只允许 `fitSignal` 与「适应宽度」两个入口。
- 约束三：`fitWidth` 的 0 尺寸守卫保留，子内容异步就绪前观察器触发不产生无效缩放。
- 约束四：正文区域边界只由 `.zoomable-preview__viewport` 的边框与底色承担；边界色不得低于 `--glass-line`（`--glass-line-soft` 在白纸旁不可见），pdf/docx 宿主必须 `width: fit-content`，内容侧（画布、pre）不得再叠加边框。
- 约束五：适配比例只能由 `fitWidthPx`（权威自然宽度）计算，禁止量取渲染尺寸（`scrollWidth` / `getBoundingClientRect`）反推；新增可缩放的预览类型必须提供 `fitWidthPx`，否则「适应宽度」只会回到 100%。
- 约束六：内容区与预览视口保持零左右内边距，正文贴面板内沿；需要内缩的提示类节点各自携带内边距。
- 约束七：`ResizeObserver` 必须只响应宽度变化（阈值 1px）且观察视口；视口必须 `scrollbar-gutter: stable`，`clampZoom` 必须向下取整——三者共同保证"适配不回灌自身"，缺一即闪。`zoomablePreview.test.tsx` 的重复触发断言是守卫。

## 验证

- `packages/ui/test/zoomablePreview.test.tsx` 三例：按 `fitWidthPx` 自动适应（500/250 → 200%），同宽度重复触发不漂移、小幅宽度变化仍落在 1% 网格（幂等/取整守卫）；手动放大后 resize 不重适应（210% 保持）、点「适应宽度」恢复（回 200%）；无 `fitWidthPx` 时「适应宽度」回到 100%。
- `vitest run test/zoomablePreview.test.tsx test/workspace.test.tsx test/themeCss.test.ts test/markdownEditorPane.test.tsx` 31 例全过；相关文件 biome 无告警（全包单例失败为既有 IME 用例，与本次无关）。
- 待实机验证：打开 PDF 后正文区域四周有常驻框线且不再闪动；适配比例让页宽正好贴满面板内沿（纸外无空白圈）；放大后横向滚动时框线固定不动；缩放工具条紧贴顶栏；收起/展开目录比例一步到位且不漂移。
