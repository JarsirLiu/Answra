# Note：CLI `/model` 选择器滚动时焦点跑出可视窗口

状态：已实施

## 问题

模型列表超过 10 项时，`/model` 选择器固定渲染前 10 项，但 `↑/↓` 会把选中索引推到整份列表末尾。焦点下移超过第 10 项后，高亮行落在渲染窗口之外，界面只剩一个消失的箭头，用户无法看到当前选中项，也无法确认 Enter 会切换到哪个模型。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/commands/ModelPicker.tsx`：可视窗口改为跟随 `selected` 的滑动窗口；上下隐藏数量分别提示。
  - `apps/cli/test/tui/commands/modelPicker.test.tsx`：新增滚动保持焦点可见的用例，更新隐藏计数文案断言。
- UI 表面：`/model` 面板的列表渲染；不改模型目录、配置持久化、Agent 运行时或 TUI 其他面板。
- 相关 Note：
  - [CLI 模型配置与选择器](../feature/2026-11-13-cli-model-config-and-picker.md)
  - [CLI `/config` 模型 ID 改为行内直接编辑](./2026-11-16-cli-config-model-direct-edit.md)

## 决定

可视窗口只由 `selected` 推导；焦点始终落在窗口内，窗口外数量用上下提示表达。不引入独立滚动状态。

## 根因

列表渲染使用 `ordered.slice(0, VISIBLE_MODELS)`，与选中索引 `selected` 完全解耦；`selected` 可以遍历整份列表，渲染窗口却永远停在前 10 项。

## 修复

- 用 `windowStart = clamp(selected - VISIBLE_MODELS + 1, 0, ordered.length - VISIBLE_MODELS)` 计算窗口起点，`visible` 从该起点切片。
- 行高亮按 `windowStart + index === selected` 判断，断言焦点始终落在当前窗口内。
- 上方用 `↑ N more…`、下方用 `↓ N more…` 提示窗口外数量；无隐藏项时不渲染提示。

## 曾考虑的替代方案

- **每次按方向键手动维护 offset 状态：** 需要额外状态并在列表加载、选中重置时同步，容易与 `selected` 分叉；用纯函数从 `selected` 推导窗口更少写入源。
- **把整个列表交给 Ink 的滚动组件：** CLI 当前没有通用滚动列表原语，为单个面板引入一套滚动容器超出本次缺陷范围。
- **只增大 `VISIBLE_MODELS`：** 只是把问题推迟到列表更长时，不解决焦点跑出窗口的根因。

## 后果与防回退

- 窗口位置只能由 `selected` 推导，不得再引入独立的滚动状态；否则选中与可见窗口会再次分叉。
- 文案断言依赖 `↑/↓ N more…`；修改提示格式时同步更新 `modelPicker.test.tsx`。
- 列表较短时 `maxStart = 0`，行为与之前一致，不额外渲染上下提示。

## 验收标准

- 可观察结果：在超过 10 项的模型列表中连续按下方向键，高亮行始终可见，列表随焦点滚动，隐藏数量提示同步变化。
- 自动化验证：`apps/cli/test/tui/commands/modelPicker.test.tsx` 覆盖焦点下移 11 项后目标行仍在窗口内，并分别断言上方/下方隐藏数量。

## 验证

- 2026-11-16：`pnpm --filter @answra/cli exec vitest run test/tui/commands/modelPicker.test.tsx`，5 项通过。

## 风险

- 终端高度较小时，面板整体高度仍可能超出可视区域；本改动只保证列表窗口内焦点可见，不处理面板外框被裁剪。
