# Note：CLI 欢迎页中文化与可选中复制

状态：已实施

## 问题

欢迎页标题仍是英文；欢迎页正文、模型配置清单与提示行使用 Ink 原生 `Text`，没有登记到 `TuiSelectionStore`，因此鼠标拖选、Ctrl+Shift+C 和 Ctrl+Shift+A 只能作用于对话消息，欢迎页无法复制。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/transcript/Transcript.tsx`、`apps/cli/src/tui/transcript/ModelSetupPanel.tsx`
- UI/进程/协议/持久化表面：CLI 欢迎页文本与选区
- 相关 Note：无

## 决定

- 欢迎页标题改为 `⏺ 欢迎使用 Answra Code！`，其余已有中文文案保持不变。
- 欢迎页标题、工作区、说明、编号提示、模型配置清单和 `TranscriptTail` 的提示/错误文本统一改用 `SelectableText`，与对话消息共用同一选区与剪贴板链路。
- 不新增欢迎页状态、账户摘要或布局组件；模型配置与就绪状态沿用原有分支。

## 影响表面

- 欢迎页所有可见文本可被现有选区操作复制。
- 未配置模型时的模型配置清单同样可选中。
- 对话消息的选区行为不变。

## 曾考虑的替代方案

- **保留 `Text`，只在欢迎页额外挂载一套复制逻辑：** 会形成第二套选区状态，坐标、提交帧和快捷键都需重复维护，舍弃。
- **只把标题改中文：** 无法解决欢迎页不可复制的问题，舍弃。

## 后果与防回退

- 欢迎页文本现在依赖 `SelectionContext`；在未提供 `selectionStore` 的非 alternate-screen 模式下，`SelectableText` 自动回退为普通 `Text`，终端原生选区仍可用。
- 新增欢迎页文本时必须使用 `SelectableText`，否则会重新出现不可复制区域。

## 验证

- `pnpm --filter @answra/cli test`：45 个测试文件通过。
- `pnpm --filter @answra/cli typecheck`：通过。
- `apps/cli/test/tui/transcript/selectableText.test.tsx` 新增用例：欢迎页提交帧后 `selectAll()` 能取得标题与工作区文本。
- 实机验证待做：Windows Terminal / VS Code 终端中拖选欢迎页并 Ctrl+Shift+C。

## 风险

- 欢迎页文本现在参与行登记；若同一行包含多个 `SelectableText`，选区按行拼接，与现有对话文本行为一致。
