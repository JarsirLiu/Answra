# Note：UI 原语与比例契约（含 openmuse 参考边界）

状态：提案

## 问题

用户连续观察到同一类视觉偏差：AI 生成 UI 时倾向于给图标上薄荷绿、把功能做成巨大的纯文字按钮、控件与文字比例明显失衡。逐项检查后，根因不在色板本身，而在令牌之外的三个缺口：

- **比例没有令牌化。** `tokens.css` 定义了 `--ctl-h: 26px`、`--font-md: 12px`、`--font-sm: 11px`、`--space-*` 和图标常量（`packages/ui/src/tokens.ts`），但控件高度、控件字号、图标尺寸之间没有成对的尺寸档。`--ctl-h` 是单值，`--font-*` 面向全界面，二者没有“哪个高度配哪个字号/图标”的契约。
- **原语没有默认比例。** `SurfaceButton.css:14` 只声明 `font: inherit`，没有 `font-size`；`SurfaceWindow.css` 的 `.surface-window-root` / `.surface-card` 也没有字号，于是新浮窗里的按钮继承浏览器默认 16px，配上 26px 高度，正是“巨大文字按钮”。`PanelShell.css:90-107` 的注释已经记录过同一个坑：`panel-header-action` 必须手工把字号钉回 `--font-md`。
- **强调色语义没有区分。** `--mint` 同时被用于主操作实底、开关、滑杆、进度条和“强调图标”；新浮窗的勾选标记与进度填充直接取 `--mint-text` / `--mint`（`SurfaceWindow.css:123-144`）。AI 只要想表达“重要/激活”就抓品牌色，于是满屏薄荷绿图标。
- **门禁只覆盖颜色。** `scripts/design/check-tokens.mjs:29-31` 只拦截 `#hex`、`rgb()/hsl()`、`--*-tint/base` 和表面二次 alpha，不拦截 `font-size: 16px`、`height: 32px`、`padding: 12px`，也不会发现“图标用了 `--mint`”。`themeCss.test.ts` 只为面板骨架和少数文件维护字号白名单，覆盖面靠人工追加。

直接原因可以概括为：**颜色治理已经做到三层令牌，但尺寸、比例和强调色选择仍是组件现场发明。** AI 面对空白会退回网页默认审美：16px 文字、大号品牌色 CTA、品牌色点缀图标。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/styles/tokens.css`
  - `packages/ui/src/tokens.ts`
  - `packages/ui/src/components/controls/`（`SurfaceButton.*`、新增按钮原语）
  - `packages/ui/src/components/floating-bar/`（`FeatureActions`、`WorkspaceControls`、`PanelShell` 头部动作、`ReplyBar`）
  - `packages/ui/src/components/panels/`（`AccountPanel`、`SettingsPanel`、`AnnouncementList`、`InterviewCapturePanel`）
  - `packages/ui/src/surfaces/`（`SurfaceNodeView`、`SurfaceWindow.css`、`SurfaceWindowApp`）
  - `packages/ui/test/themeCss.test.ts`、新增 `packages/ui/test/controlsContract.test.tsx`
  - `scripts/design/check-tokens.mjs`
  - 根 `package.json`（`verify` 接入 `tokens:check`）
  - `AGENTS.md`（UI 原语与比例规则）
- UI/进程/协议/持久化表面：只影响 `@answra/ui` 的渲染层；不改变 Electron 主进程、IPC、窗口策略、捕获保护、IME 或持久化。
- 相关 Note：
  - [UI 设计令牌治理与组件库映射边界](2026-10-28-design-token-governance.md)
  - [UI 令牌契约第一批收口](../../implemented/architecture/2026-10-28-ui-token-contract-first-pass.md)
  - [UI 尺寸令牌补齐](../../implemented/process/2026-10-28-ui-size-tokens.md)
  - [字号令牌补齐并清零组件 CSS 里的 px 字面量](../../implemented/bug-fix/2026-10-20-font-size-token-hardcode.md)
  - [悬浮表面视觉契约](../../implemented/architecture/2026-10-11-floating-surface-visual-contract.md)
  - [声明式浮窗系统 P0](../../implemented/architecture/2026-11-11-declarative-surface-p0.md)

## 提案

### 0. 参考 openmuse 的判断：学结构，不学皮肤

`D:\codespace\openmuse` 是移动端触控产品，视觉语言是大字号、大触控区、大圆角、柔色卡片：正文 15px、按钮最小 42–44px、卡片圆角 23px、色板为 `canvas/card/blue/green/orange` 等柔和角色色（`apps/mobile/src/ui.tsx:18-113`）。Answra 是透明窗口里的密集桌面工具：26px 控件、12px 界面字号、4px 栅格、单一薄荷绿强调色。直接照搬皮肤会破坏密度、窗口 fit-content 与变色龙约束。

值得学习的是它的**实现纪律**，不是它的数值：

| openmuse 做法 | Answra 是否采用 | 映射方式 |
| --- | --- | --- |
| `Button` / `IconButton` / `Card` / `Text` 原语各自持有尺寸与变体（`ui.tsx:115-188`） | 采用 | 把 `SurfaceButton` 补成有尺寸档的原语，新增 `IconButton` |
| 按钮文字始终用 `colors.text`，`primary` 只换背景色（`ui.tsx:126-147`） | 采用 | 强调色只允许做实底/填充，默认前景仍是 `--ink` / `--icon` |
| 图标默认 `colors.text`，不因按钮类型变品牌色（`ui.tsx:184`） | 采用 | 图标默认 `--icon`；状态图标走 `--success` / `--danger` / `--warning` |
| 42–44px 触控目标、23px 圆角、15–16px 正文、柔色相板 | 不采用 | 与桌面密集悬浮条冲突；维持 22/26/32px 控件档与中性灰阶 |
| 颜色角色硬编码在 `ui.tsx`，没有独立令牌层 | 不采用 | Answra 的颜色令牌层更成熟，保留现有三层结构 |

### 1. 在颜色令牌之上补一层“比例角色”

保留现有原始参数 → 感知令牌 → 组件别名三层，新增**控件比例档**，只描述控件，不描述正文内容：

```css
--control-h-sm: 22px;
--control-h-md: 26px;
--control-h-lg: 32px;
--control-font-sm: var(--font-xs);
--control-font-md: var(--font-md);
--control-font-lg: var(--font-sm);
--control-icon-sm: 12px;
--control-icon-md: 14px;
--control-icon-lg: 16px;
--control-pad-sm: 6px;
--control-pad-md: 7px;
--control-pad-lg: 10px;
```

约束：

- 控件尺寸只允许来自 `sm/md/lg` 三档；`md` 是悬浮条与面板头部的默认档。
- 现有 `--ctl-h` / `--ctl-min-w` / `--ctl-radius` / `--ctl-pad-x` 保留为 `md` 档的兼容别名，迁移完成后由 `--control-*` 取代，避免一次性重命名扩大 diff。
- TS 侧 `tokens.ts` 只同步图标数值常量，不再新增第二套尺寸常量；组件通过 CSS 变量消费。
- 正文内容（答案、笔记、代码、diff、预览）继续使用各自内容尺度，不进入控件档；这是 `tokens.css:57-58` 已确立的豁免。

### 2. 原语契约：让默认值就是正确比例

- **`SurfaceButton`**：新增 `size?: "sm" | "md" | "lg"`，默认 `md`。CSS 基类自己声明 `height: var(--control-h-*)`、`font-size: var(--control-font-*)`、`padding: 0 var(--control-pad-*)`、`gap: var(--ctl-gap)`，不再依赖 `font: inherit` 继承到 16px。带图标时图标尺寸由同一档决定。
- **新增 `IconButton`**：只接受图标 + 必填 `label`（同时作为 `aria-label`），宽度与高度相同，默认 `md`。文字按钮与图标按钮分成两个原语，避免“把字塞进 26px 方块”或“给图标按钮加大字号”两种错误同时存在。
- **`PanelShell` 头部动作、`ReplyBar`、`FeatureActions`、`WorkspaceControls`、`SurfaceWindow` 关闭钮**：统一改用上述原语，删除各自重复的 `height` / `padding` / `font-size` / 颜色规则。
- **每个浮窗/面板最多一个 `primary`**：这是产品语义约束，写在 `AGENTS.md` 和组件注释里，不靠 CSS 强制；需要多个高优先级动作时改用 `default` 或 `quiet`。

### 3. 强调色规则：mint 只做“面”，不做“字/图标”

- 允许使用 `--mint` 的场景：主操作按钮实底、进度条填充、开关开启轨道、滑杆填充与拇指、选中态的淡色底（`--mint-wash`）。
- 默认前景：图标用 `--icon`，文字用 `--ink`，次要动作用 `--muted`（`quiet` 变体）。
- 状态图标用状态令牌：成功 `--success`、警告 `--warning`、危险 `--danger`；勾选标记属于状态，不再用 `--mint-text`。
- 新增 `check-tokens.mjs` 规则：扫描 `color:` / `border-color:` / `fill:` / `stroke:` 中出现 `var(--mint...)` 的声明，只允许白名单内的文件片段（主操作实底上的对比色、进度/开关/滑杆填充）。白名单逐项写理由，不允许整目录放行。

### 4. 把比例与强调色变成门禁

分三步收紧，避免一次性阻断所有历史字面量：

1. **原语守卫（本次）**：`check-tokens.mjs` 对 `components/controls/**`、`surfaces/**`、`components/floating-bar/**` 禁止 `font-size` / `height` / `min-height` / `padding` / `gap` 的 px 字面量；只允许 `var(--control-*)`、`var(--font-*)`、`var(--space-*)`、`var(--ctl-*)`。
2. **面板骨架（随迁移）**：把 `components/panels/**` 的界面骨架文件纳入同一规则，内容区文件（`chat/`、`tool-call/`、`workspace/` 预览、编辑器）显式列入内容尺度豁免，豁免必须带注释。
3. **全量（收尾）**：`themeCss.test.ts` 的字号白名单与 `check-tokens.mjs` 的比例规则合并成一份可读的允许清单；`package.json` 的 `verify` 接入 `tokens:check`，让颜色与比例同时成为提交门禁。

同时新增 `controlsContract.test.tsx`：

- `SurfaceButton` 三档 size 输出正确类名，默认 `md`；`primary` 不改变文字色令牌来源。
- `IconButton` 必须有 `label`，渲染为方形按钮且不含文本节点。
- `SurfaceWindowApp` 的关闭钮与操作按钮使用原语，不再出现裸 `<button>` 或 `--mint` 图标。

### 5. 迁移顺序

1. **P0 原语与浮窗**：新增比例令牌、扩展 `SurfaceButton`、新增 `IconButton`；浮窗视觉（`SurfaceWindow.css` / `SurfaceNodeView`、勾选标记改状态色）由声明式浮窗的后续变更承接，避免与并行工作冲突。
2. **P1 悬浮条与回复条**：`FeatureActions`、`WorkspaceControls`、`ReplyBar`、`PanelShell` 头部动作全部改用原语；删除重复尺寸规则。
3. **P2 面板**：`AccountPanel`、`SettingsPanel`、`AnnouncementList`、`InterviewCapturePanel` 的按钮统一到原语；逐文件消除按钮相关字面量。
4. **P3 门禁收口**：扩展 `check-tokens.mjs` 与 `themeCss.test.ts`，接入 `pnpm verify`；更新 `AGENTS.md` 的 UI 章节，写明“按钮只用 `SurfaceButton` / `IconButton`、图标默认 `--icon`、mint 只做面、控件尺寸只用三档”。

### 明确不做

- 不引入 Tailwind、shadcn 或第二套主题色板（沿用 [令牌治理提案](2026-10-28-design-token-governance.md) 的边界）。
- 不把 openmuse 的移动端字号、触控尺寸、圆角或柔色相板搬进 `@answra/ui`。
- 不为正文内容建立统一字号：对话、笔记、代码、diff 继续使用内容尺度。
- 不新建 Storybook 或独立预览应用；用 `controlsContract.test.tsx` + `SurfaceWindowApp.test.tsx` 作为可执行参考。
- 不做自动布局重排或设计稿生成；本提案只固定原语、比例和门禁。

## 当前实施进度

已实施（本变更）：

- `tokens.css` 新增 `--control-h/font/icon/pad` 的 `xs/sm/md/lg` 档，`--ctl-*` 统一作为 `md` 档别名。
- `SurfaceButton` 自带尺寸档与显式字号；新增 `IconButton`，强制 `label`，图标尺寸随档缩放。
- 已迁移：悬浮条 `FeatureActions` / `WorkspaceControls`、`FloatingLayerHost`、`PanelShell` 关闭钮与头部动作、`ReplyBar`、`AccountPanel`、`SettingsPanel`、`AnnouncementList`、`InterviewCapturePanel`、`UpdateSettingsGroup`。
- `check-tokens.mjs` 新增控件尺寸字面量与薄荷前景色两条规则；`tokens:check` 已接入 `pnpm verify`。
- 新增 `packages/ui/test/controlsContract.test.tsx`；`AGENTS.md` 增加“UI 原语与比例”章节。

未实施或由其他变更承接：

- `packages/ui/src/surfaces/` 的浮窗内容不在本变更内，由声明式浮窗的后续变更承接：浮窗按钮改用原语、勾选标记从 `--mint-text` 改为状态色。
- `ModePicker` 的菜单触发与菜单项仍是专用 row/tab 结构，已改用尺寸/间距令牌但未合并进按钮原语。
- 面板内容区（对话、工具调用、工作区、编辑器）的内容尺度继续豁免；面板骨架的全量尺寸守卫留在后续阶段。

因此本 Note 保持“提案”状态；浮窗变更合入并把剩余面板骨架纳入守卫后，再迁移为“已实施”。

## 模块边界

- `tokens.css`：只定义原始参数、感知令牌、比例档和内容原语；不写组件选择器，不定义按钮变体。
- `tokens.ts`：只放 TS 侧需要的图标数值常量；不复制 CSS 尺寸表。
- `components/controls/`：按钮、开关、滑杆等原语的唯一实现处；负责默认比例与强调色语义，业务组件不得重写按钮基础样式。
- `components/floating-bar/`、`components/panels/`、`surfaces/`：只组合原语和布局，不得出现 `font-size` / `height` / 按钮颜色字面量。
- `scripts/design/check-tokens.mjs`：颜色、原始令牌与比例的唯一静态门禁；新增豁免必须写理由。
- `themeCss.test.ts` / `controlsContract.test.tsx`：把令牌契约和原语行为变成可失败测试。
- `AGENTS.md`：面向人类与 AI 的简短使用规则；不重复完整令牌表。

## 曾考虑的替代方案

- **直接照搬 openmuse 的视觉风格（大字号、大触控、柔色、大圆角）：** 舍弃。它是移动端触控表面，Answra 是透明窗口里的密集桌面工具；直接换皮肤会破坏 26px 控件密度、fit-content 窗口高度与变色龙的表面不透明约束，还会引入第二套品牌色。
- **只给 `SurfaceButton` 补 `font-size`：** 舍弃。这能修掉当前浮窗的一处症状，但没有解决“图标为什么变绿”“新组件为什么继续发明尺寸”“门禁为什么不拦”三个复发条件；下一次新增面板仍会漂移。
- **全局加 `button { font-size: var(--font-md) }` 兜底：** 舍弃。正文区按钮与内容尺度需要不同字号，全局规则会覆盖内容语义，并制造 CSS 与组件原语两个真相来源；原语自带比例更可靠。
- **一步把 `packages/ui` 所有 px 字面量清零：** 舍弃。范围过大，会把对话、代码、diff、预览等有意保留的内容尺度一起误伤；分阶段迁移 + 内容豁免更可控。
- **引入 Tailwind/shadcn 用其默认按钮与主题：** 舍弃。会绕过 `[data-theme]`、变色龙和 `--fade`，并引入 `bg-*/80`、默认阴影与第二套语义色板，和既有令牌治理结论冲突。
- **新建 Storybook 作为视觉参考：** 暂缓。维护成本和构建链路收益不匹配；当前用测试 + 浮窗实例即可固定契约，后续确有需要再单独立项。

## 验收标准

- 可观察结果：
  - 新浮窗、面板头部、悬浮条中的文字按钮高度与字号成对来自同一档，不再出现 26px 高配 16px 字。
  - 图标默认中性色；薄荷绿只出现在主操作实底、进度、开关、滑杆和选中底色上。
  - 新增按钮只能通过 `SurfaceButton` 或 `IconButton` 实现，文字按钮与图标按钮不再混用。
- 自动化验证：
  - `pnpm --filter @answra/ui test -- --run test/controlsContract.test.tsx test/themeCss.test.ts test/SurfaceWindowApp.test.tsx`
  - `pnpm tokens:check`
  - `pnpm verify`（`tokens:check` 已接入）
  - `pnpm notes:check`
- 需要的实机验证：
  - 浅色/深色 × 变色龙开/关 × 透明度 `1`/`0.7`/`0.5`，检查悬浮条、面板头部、账户页动作、公告详情、回复条、独立浮窗的按钮比例与图标颜色。
  - Windows 与 macOS 各一次；确认浮窗按钮仍可点击、拖动区未被 `IconButton` 覆盖。
  - 确认删除的重复高度规则没有改变 fit-content 窗口上报高度。

## 风险

- 控件从 26px 迁移到分档后，个别布局可能发生 2–6px 位移；浮窗高度由渲染器上报，需要在实机上确认 `fitSurface` 仍收敛。
- 比例门禁初期需要维护豁免清单；如果按目录整体放行，会重新制造“组件自行发明尺寸”的盲区，因此豁免必须逐文件、带理由。
- `IconButton` 强制 `label` 会增加调用方负担，但这是可访问性与“禁止图标按钮塞文字”的同一道约束，不能为了省事放开。
- “每个表面最多一个 primary”只能靠评审和 `AGENTS.md` 约束，CSS 无法可靠判断视觉层级；如果未来出现多主操作场景，应在产品层定义优先级，而不是放宽令牌。
- 本提案不改变内容区字号与排版；对话、笔记、代码和 diff 的观感不在本次验收范围内。
- openmuse 只作为结构参考；其移动端数值、柔色相板和 23px 圆角不得进入本仓库，否则会与现有悬浮表面契约冲突。
