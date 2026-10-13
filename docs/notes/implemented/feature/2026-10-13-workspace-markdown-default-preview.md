# Note：工作区 md 编辑器预览/源码双模式

状态：已实施

## 问题

用户对 md 打开体验的诉求经多次澄清收敛为：**默认进入可编辑态，需要看渲染效果时切到预览态查看**。此前实现是「只读预览 + CodeMirror 源码」双态，打开先见原始文本，被用户误解为"没渲染 markdown"；中途实现过"左源码右预览"分屏，被用户明确否定（不是分屏需求）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/MarkdownEditorPane.tsx`（重写）、`WorkspacePanel.tsx`、`WorkspacePanel.css`、`css-modules.d.ts`；新增依赖 `react-markdown`、`remark-gfm`、`rehype-raw`、`rehype-sanitize`、`@codemirror/*`（**移除**了早期评估引入的 `vditor` 依赖）。
- UI 表面：工作区内容区 md 编辑；不影响 IPC、主进程与持久化格式（仍存原始 markdown）。

## 决定

- 编辑器双模式（工具栏切换）：
  - `source`（默认）：CodeMirror 6 编辑原始 markdown，懒加载语言包与 `@codemirror/*` 子模块（`import()` 不进主启动 chunk）。
  - `preview`：`react-markdown` + `remark-gfm` + `rehype-raw` 静态渲染（内嵌 HTML 如 `br`/`a` 经 `rehype-raw` 渲染），`rehype-sanitize` 兜底白名单；图片走 `answra-file` 协议经 `toResourceUrl(resolveRelative(dir, src))` 解析相对路径。
  - 切到 `preview` 时 CodeMirror 实例销毁，最近一次全文缓存在 `lastTextRef`；切回 `source` 还原。预览为静态只读，编辑只发生在 `source` 态。
- 粘贴/拖拽图片：`pasteImageName` 拦截，经 workspace IPC 写入 `assets/`，插入相对链接；两态共用同一落盘逻辑。
- 保存策略：输入置脏 → 800ms 防抖自动写盘；Ctrl/Cmd+S 手动保存。保存统一走 `readActiveText()`：取 CodeMirror 文档（仅 `source` 态可编辑）。
- 外部变更刷新：未保存编辑时静默 `baselineRef` 重置 / CodeMirror 全文替换；有未保存编辑弹冲突提示（保留）。
- 撤销之前的只读预览分屏方案与 Vditor IR 评估方案（Vditor 已移出依赖）。

## 影响表面

- 工作区打开 `.md` 文件的交互：默认进入 `source` 可编辑态，工具栏显式切到 `preview` 查看渲染；粘贴/拖拽图片落盘并插入相对链接；保存为防抖 + Ctrl/Cmd+S。
- 不影响 IPC、主进程与持久化格式（仍存原始 markdown）。

## 曾考虑的替代方案

- **左源码右实时预览分屏：** 实现快但被用户明确拒绝，非其需求形态，回退。
- **只读预览 + 源码双态（上一版）：** 打开即原始文本，易让用户误以为"没渲染"，改为默认 `source` 由工具栏切 `preview` 显式查看渲染。
- **Vditor / Milkdown / TipTap+tiptap-markdown 即时渲染：** 评估过所见即所得质量，但 md 往返序列化对内嵌 HTML、表格等保真度与配置成本高，且本项目预览用 react-markdown 静态渲染已可正确呈现内嵌 HTML，源码编辑用 CodeMirror 保真度最高，最终采用「CodeMirror 源码 + react-markdown 预览」组合，不引入 IR 依赖。

## 后果与防回退

- md 打开默认进入 `source`（CodeMirror 原始文本）可编辑态；`preview` 为显式切换的渲染查看态，所见即所存（存的是 markdown 源）。
- 预览态为静态只读，复杂内嵌 HTML 结构建议在 `source` 态编辑。
- 回退约束：不得改回"打开先见原始文本且无预览入口"或分屏；保存必须为原始 markdown（不引入中间格式）。

## 验证

- `packages/ui` typecheck 与 vitest（markdownEditorPane 行为用例 + 全量 88 用例）通过。
- 实机验证项：打开 md 默认源码可编辑；切 `preview` 看渲染（内嵌 HTML/图片/表格正常）；切回 `source` 内容还原；粘贴图片落盘 `assets/` 并渲染；Ctrl+S 与防抖保存。

## 修正记录：watcher 回声导致编辑抖动（实机反馈）

实机验证发现编辑时内容抖动、冲突提示误弹。根因是回声循环：800ms 防抖自动保存写盘 → `fs.watch` 推送 `changed` → 外部变更逻辑未区分"自己刚写的"，读盘后整体重置编辑器，打字被重置；若用户在保存后继续输入（dirty）还会误触发冲突横幅。修正：新增 `lastWrittenRef` 记录最近一次落盘内容，外部变更先读盘，内容与最近落盘一致（回声）则直接忽略；真实外部变更才走"静默刷新/冲突提示"分支。文件切换时重置标记。防回退约束：外部变更处理必须先做回声抑制再判定冲突，不得恢复"收到 changed 即重置编辑器"的行为。
