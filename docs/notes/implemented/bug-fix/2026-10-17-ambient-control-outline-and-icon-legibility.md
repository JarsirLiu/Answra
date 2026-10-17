# Note：变色龙下的输入框边界与功能图标可见性

状态：已实施

## 问题

开启变色龙后，用户反馈两点：「对话面板这些输入框组件边框看不见了」，以及「图标是不是也得受变色龙管控，让能看清应用内的所有功能入口」。

实际表现：面板里的输入区（对话 composer、笔记本编辑区、设置输入框、工作区筛选框）与背景同色、边界消失，看起来是一片空白；功能图标也被拉成接近背景的灰度，入口难以辨认。用户原话补充：「输入框这些，边框还是需要的，不用无边框」。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useAmbientTheme.ts`、`packages/ui/src/styles/tokens.css`（新增控件描边原始参数与感知令牌）、`packages/ui/src/theme.ts`（`COLOR_GROUPS.line`）、控件与输入区样式（`styles/shared.css`、`panels/ConversationComposer.css`、`panels/SettingsPanel.css`、`panels/workspace/DirectoryTree.css`、`panels/workspace/WorkspacePanel.css`、`panels/SourcesPanel.css`、`controls/Switch.css`、`controls/RangeSlider.css`、`chat/MessageStream.module.css`）。
- UI/进程/协议/持久化表面：纯表现层令牌，IPC、窗口与持久化契约不变。
- 相关 Note：[变色龙隐蔽强度与表面融底](../feature/2026-10-17-ambient-veil-levels-and-blended-surface.md)（本 Note 修复其过度应用）、[变色龙只接管表面固有色](../feature/2026-10-17-ambient-surface-only-and-light-palette.md)、[移除隐蔽强度四档](../simplification/2026-10-17-remove-ambient-veil-levels.md)。

## 根因

上一版把「融底」规则一刀切地套到**全部**描边与图标上：

1. `--line-tint` 被写成背景原色，而所有控件边界都从 `--line-*` 派生（`.input-surface` 的 `border: 1px solid var(--glass-line)`、composer 的 `calc(var(--line-base) + 0.04)`、设置输入框与筛选框的 `--glass-line-soft`）。描边通道等于背景色，alpha 再高也是同色，输入框等于没有边界。
2. `--icon-tint` 由 `mix(ink, bg, iconMix)` 派生（默认档 0.18），而文字 ink 本身已被压到 2:1，再向背景拉 18% 后图标落入 ~1.7:1，功能图标比正文更弱。

根因是**结构轮廓**与**控件边界**共用了一个参数：前者融底可以接受，后者是「这里能点、能输入」的唯一线索，必须有可见下限。图标同理——它是入口本身，不是装饰。

## 决定

- 描边拆成两组原始参数，语义分离：
  - `--line-tint` / `--line-base`(0.14) / `--line-soft-base`(0.08)：**结构轮廓**（悬浮条/面板/菜单外形、分隔线、内容气泡）。
  - `--edge-tint` / `--edge-base`(0.16) / `--edge-strong-base`(0.24)：**控件描边**（输入框、开关轨道、滑杆轨道、可点行、回到底部按钮），新增感知令牌 `--edge-line` / `--edge-line-strong`，比结构线重一档。
- 两组描边的分工固定：变色龙只允许把**结构轮廓**的 alpha 基数归零（远距离伪装，见 [变色龙只接管表面固有色](../feature/2026-10-17-ambient-surface-only-and-light-palette.md)）；**控件描边 `--edge-*` 任何时候都不由变色龙改写**，边界只来自调色板实色。
- 图标改用调色板 `--icon-tint`（浅色 `#6E7E8C` / 深色 `#96AEC2`，比正文再柔一档），不再按背景派生、不再比正文更弱。
- `COLOR_GROUPS.line` 同时覆盖 `--line-tint` 与 `--edge-tint`，否则用户选「描边」颜色只改一半。

## 修复

- `packages/ui/src/styles/tokens.css`：新增 `--edge-tint` / `--edge-base` / `--edge-strong-base` 与 `--edge-line` / `--edge-line-strong`；深色主题翻转 `--edge-tint` 为白；注释写明两类描边的分工。
- `packages/ui/src/hooks/useAmbientTheme.ts`：不再写图标/文字/控件描边令牌；结构轮廓与投影归零（详见 feature Note）。
- 控件与输入区样式改引用 `--edge-line`（composer 焦点态用 `--edge-line-strong`）：`shared.css` 的 `.input-surface`、`ConversationComposer.css`、`SettingsPanel.css` 的 `.setting-field input`、`DirectoryTree.css` 的 `.workspace-tree__filter`、`WorkspacePanel.css` 的 `.workspace-panel__change-root`、`SourcesPanel.css` 的 `.source-list li`、`Switch.css` 的 `.switch-track`、`RangeSlider.css` 两条轨道、`MessageStream.module.css` 的 `.jumpButton`。结构轮廓、分隔线与内容卡片仍用 `--glass-line*`。
- 测试：`packages/ui/test/useAmbientTheme.test.tsx` 断言变色龙不写 `--icon-tint` / `--edge-*`，只把 `--line-base` / `--line-soft-base` / `--shadow-*` 归零；`packages/ui/test/theme.test.tsx` 断言 `line` 分组同时展开两个 tint，且变色龙开启时用户选的描边色不被抹掉。

## 曾考虑的替代方案

- **给控件描边加投影（`--shadow-ctl`）来救可见性：** 投影是远距离最先暴露悬浮层的信号，等于把伪装目标还回去，因此不用；边界靠色差而不是明暗对比。
- **控件描边继续从 ink 按 alpha 派生（如 ink 0.35）：** ink 若被压到低对比，alpha 稀释后仍是同色不可见；边界必须是固有色。
- **让变色龙把控件描边取成「背景与文字色的中间色」：** 曾经实现过（实心 ~1.5:1），但既然已经不再按背景调文字对比度，中间色只会让边界比调色板更弱；统一走调色板更简单。
- **只提高 `iconMix`（如 0.06）：** 图标与文字的对比度仍会随档位分叉，且「图标比正文弱」本身就是错的入口设计。
- **在设置页加「输入框可见性」开关：** 多一个用户要理解的旋钮，默认值仍会踩同一个坑，不解决根因。

## 影响表面

- 输入框、开关、滑杆、可点行的边界在任何模式下都可见；功能图标与正文同属一个调色板色系。
- 默认（非变色龙）主题：输入框/控件边框由 `alpha 0.08~0.12` 统一到 `0.16`（结构线 0.14），边界更明确，属预期变化。
- 结构轮廓、分隔线与内容卡片在变色龙下仍是调色板实色（不再被抹成背景色，也不再与背景同色隐藏）。

## 后果与防回退

- 硬约束：**控件边界与功能图标不允许被背景色抹掉。** 任何「可点/可输入/是入口」的元素必须有不依赖背景的可见边界。
- 新增控件边界一律使用 `--edge-line` / `--edge-line-strong`，不得直接引用 `--glass-line*`；结构轮廓、分隔线、内容卡片使用 `--glass-line*`，不得反向引用 `--edge-*`。
- 变色龙不得再写入 `--line-*` / `--edge-*` / `--icon-tint`：这些是前景可读性契约，不是表面固有色。
- 用户颜色分组新增描边类令牌时必须同时挂到 `COLOR_GROUPS.line`。

## 验证

- `packages/ui/test/useAmbientTheme.test.tsx`：断言 `deriveAmbientTokens` 只输出 `--glass-tint` / `--panel-tint` / `--paper-tint`，其余键（含 `--line-*`、`--edge-*`、`--icon-tint`、`--shadow-*`）一律不写。
- `packages/ui/test/theme.test.tsx`：`line` 分组展开出 `--line-tint` 与 `--edge-tint`；变色龙开启时用户选的文字/描边色仍然生效，表面键以变色龙为准。
- `packages/ui` 全部 206 个测试通过；`pnpm verify` 通过。
