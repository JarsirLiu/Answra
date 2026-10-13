# Note：工作区 md 编辑器改为 Typora 式即时渲染（IR）

状态：已实施

## 问题

用户对 md 打开体验的诉求经两次澄清收敛为：**平时默认看到的就是渲染好的 markdown，光标点进去直接改（Typora 式即时渲染），需要源码时再切纯文本模式**。此前实现是「只读预览 + CodeMirror 源码」双态，打开先见原始文本，被用户误解为"没渲染 markdown"；中途实现过"左源码右预览"分屏，被用户明确否定（不是分屏需求）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/MarkdownEditorPane.tsx`（重写）、`WorkspacePanel.tsx`、`WorkspacePanel.css`、`css-modules.d.ts`；新增依赖 `vditor`
- UI 表面：工作区内容区 md 编辑；不影响 IPC、主进程与持久化格式（仍存原始 markdown）。

## 决定

- 编辑器双模式：`wysiwyg`（默认，Vditor IR 即时渲染）与 `source`（CodeMirror 原始文本，兜底处理内嵌 HTML 等边角情况）。Vditor 内部保留原始 markdown 源，`getValue()` 无损回传，保存格式与旧实现完全兼容。
- Vditor 配置：`mode: "ir"`、无工具栏、无计数器、无缓存，深色主题 + 自有 CSS 覆盖（透明背景、字号 13.5px、跟随 `--ink`），懒加载 `import("vditor")` 与 `import("vditor/dist/index.css")` 不进启动 chunk。
- 粘贴/拖拽图片：`upload.handler` 拦截，经 workspace IPC 写入 `assets/`，`insertValue` 插入相对链接；源码模式沿用原 paste 拦截逻辑。
- 保存策略不变：输入置脏 → 800ms 防抖自动写盘；Ctrl/Cmd+S 手动保存。保存统一走 `readActiveText()`：IR 模式取 `vditor.getValue()`，源码模式取 CodeMirror 文档。
- 外部变更刷新：未保存编辑时静默 `vditor.setValue()` / CodeMirror 全文替换；有未保存编辑弹冲突提示（保留）。
- 撤销之前的只读预览分屏方案与 react-markdown 预览态（预览组件不再由本面板使用；`rehype-raw`/`rehype-sanitize` 依赖保留给可能复用的场景）。

## 曾考虑的替代方案

- **左源码右实时预览分屏：** 实现快但被用户明确拒绝，非其需求形态，回退。
- **只读预览 + 源码双态（上一版）：** 打开即原始文本，违背"默认即渲染"诉求，废弃。
- **Milkdown / TipTap+tiptap-markdown：** 所见即所得质量好，但 markdown 往返序列化对内嵌 HTML、表格等保真度与配置成本更高，且 Vditor IR 模式本身就是 Typora 同款交互，选 Vditor。

## 后果与防回退

- md 打开默认即 IR 渲染态，所见即所存（存的是 markdown 源）；预览/编辑不再区分，源码为显式切换的兜底。
- IR 模式对内嵌 HTML 的编辑支持有限（能显示，复杂结构建议切源码改）；内嵌 HTML 在 IR 渲染由 Vditor 处理。
- 回退约束：不得改回"打开先见原始文本"或分屏；保存必须为原始 markdown（不引入中间格式）。

## 验证

- `packages/ui` typecheck 与 vitest（11 文件 83 用例）通过。
- 实机验证项：打开 md 默认渲染态；直接点入编辑、`##` 回车转标题；粘贴图片落盘 `assets/` 并渲染；源码模式往返无损；Ctrl+S 与防抖保存。

## 修正记录：watcher 回声导致编辑抖动（实机反馈）

实机验证发现编辑时内容抖动、冲突提示误弹。根因是回声循环：800ms 防抖自动保存写盘 → `fs.watch` 推送 `changed` → 外部变更逻辑未区分"自己刚写的"，读盘后 `setValue()` 整体重置编辑器，打字被重置；若用户在保存后继续输入（dirty）还会误触发冲突横幅。修正：新增 `lastWrittenRef` 记录最近一次落盘内容，外部变更先读盘，内容与最近落盘一致（回声）则直接忽略；真实外部变更才走"静默刷新/冲突提示"分支。文件切换时重置标记。同时把 react-markdown 预览态的排版样式（标题层级/引用/代码/表格/图片圆角）迁移到 `.vditor-reset`，保证 IR 渲染效果与旧预览一致。防回退约束：外部变更处理必须先做回声抑制再判定冲突，不得恢复"收到 changed 即重置编辑器"的行为。
