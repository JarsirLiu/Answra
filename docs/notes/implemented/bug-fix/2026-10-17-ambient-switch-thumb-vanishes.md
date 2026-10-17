# Note：变色龙下开关关闭态拇指不可见

状态：已实施

## 问题

用户报告：开启「跟随背景色」（变色龙）后，设置面板里「会议隐身」开关关闭时的小圆球（拇指）几乎看不见，只剩一圈浅色轨道（附截图确认）。这是深浅色两种调色板下都可能出现的观感缺陷，变色龙开启时最严重——开关作为"这里能点"的控件，状态完全无法辨认。

## 涉及范围

- 代码/模块：`packages/ui/src/components/controls/Switch.css`（`.switch-thumb`、`.switch.is-on .switch-thumb`）、`packages/ui/test/themeCss.test.ts`（新增守卫）。
- UI/进程/协议/持久化表面：纯表现层令牌引用；IPC、窗口与持久化契约不变。
- 相关 Note：[变色龙只接管表面固有色](../feature/2026-10-17-ambient-surface-only-and-light-palette.md)（`--paper-tint` 被运行时重写、`--shadow-*` 被归零的来源）、[变色龙下的输入框边界与功能图标可见性](2026-10-17-ambient-control-outline-and-icon-legibility.md)（「控件边界不允许被背景色抹掉」契约的来源）。

## 根因

`useAmbientTheme.ts` 会把 `--paper-tint` 重写为本地背景色（`deriveAmbientTokens`），并归零 `--shadow-ctl-base`。而关闭态拇指的原实现是：

1. `background: var(--paper)`——拇指引用了**表面固有色**。变色龙把它写成采样背景的本地色后，拇指颜色变成「面板颜色」本身。
2. `box-shadow: var(--shadow-ctl)`——拇指轮廓唯一依赖的投影被归零，只剩轨道描边（`--edge-line`，语义上不被变色龙改写）。

于是拇指 = 白/本地色圆点 + 无投影，落在只比面板深约 10% alpha 的 `--field-strong` 轨道里，填充对比约 1.1:1，肉眼不可分辨。设计上 `--paper` 是表面令牌（被变色龙接管），拇指却是需要独立可见性的控件件——语义用错了层。

## 决定

- 拇指按**控件件**取色：关闭态 `background: var(--icon)`（调色板控件实色，如浅色 `#6E7E8C`），任何模式下都与轨道有色差、不由变色龙改写。
- 开启态拇指铺在薄荷色轨道上（`--mint` 实底 vs 白拇指对比足够），保持 `background: var(--paper)` 与 iOS 观感。
- 关闭→开启的 `background` 变化加入 transition（140ms，与 transform 一致）。
- 新增 CSS 完整性守卫测试：`.switch-thumb` 基础规则必须引用 `--icon` 且不得引用 `--paper`，`.is-on` 规则才回 `--paper`——防止后续把表面令牌再加回来。

## 修复

- `packages/ui/src/components/controls/Switch.css`：`.switch-thumb` 基础 `background: var(--icon)`；`.switch.is-on .switch-thumb` 增加 `background: var(--paper)`；`transition` 加入 `background 140ms ease-out`。
- `packages/ui/test/themeCss.test.ts`：新增 "keeps the switch thumb off the ambient surface tokens" 守卫。

## 曾考虑的替代方案

- **给拇指加一圈固定描边（border/ring）保白拇指：** `--edge-*` alpha 低（0.16~0.24 × fade），与轨道填充的实际色差约 1.1~1.25:1，在浅色面板上仍接近不可见；提示描边时专辑已论证"边界靠色差而不是明暗对比"，色差本身不够就不是可靠方案。
- **保持 `--paper` 加深轨道填充：** 需要把 `--field-strong` 的 alpha 显著加大才够对比，所有主题下轨道都会明显变灰，且修复依赖"轨道恰好和拇指拉开距离"这一间接条件，变色龙的 `--paper-tint` 接近任意背景后仍可能翻车。
- **只在变色龙开启时换样式：** 运行时按模式分支复杂，且根因是"表面令牌用于控件件"这一语义错误，而非变色龙本身；分层正确后各模式自然成立。

## 影响表面

- 关闭态拇指从白色变为控件灰色（默认浅色主题也有此变化：白→灰），状态分辨更明确；开启态、禁用态（`.is-disabled .switch-thumb` 仍为 `--icon` + `opacity: 0.6`，且在基础规则之后覆盖）观感均不变。
- 其他控件（滑杆、按钮）未被触碰；`--icon` 随 `--fade` 变透明，拇指同步跟随前景透明度，与此前控件行为一致。

## 后果与防回退

- 硬约束：**拇指/旋钮等小尺寸控件件不得引用 `useAmbientTheme` 会重写的表面令牌**（`--paper` / `--glass` / `--panel`），必须用前景控件令牌（`--icon` / `--ink` / `--edge-*`）。
- `themeCss.test.ts` 守卫已固化该约束；后续改动 `Switch.css` 被该测试拦截。

## 验证

- `packages/ui/test/themeCss.test.ts`：新增守卫断言通过（基础规则 `--icon` 且无 `--paper`；`.is-on` 规则含 `--paper`）。
- `packages/ui` 全量 29 个测试文件 216 项全部通过；`npx biome check` 对改动文件 0 警告。
- 实机：用户在变色龙模式下确认「会议隐身」开关关闭态拇指可见（截图复述的缺陷在修复后消除）。
