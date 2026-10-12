# Note：工作区 markdown 编辑器与图片粘贴

状态：提案

## 问题

工作区 md 文档需要接近本地编辑器的体验：语法高亮编辑、粘贴截图直接入库展示、外部改动后编辑器内容刷新且不丢光标。现有 `NotesPanel` 的裸 `<textarea>` 无法承载。

## 涉及范围

- 代码/模块：`packages/ui`（新增编辑器组件，新增依赖 `@codemirror/state`、`@codemirror/view`、`@codemirror/commands`、`@codemirror/search`、`@codemirror/language`、`@codemirror/lang-markdown`）
- UI/进程/协议/持久化表面：工作区面板内容区；图片经 `workspace` IPC 写入文档同目录 `assets/`；外部变更经 `changed` 推送刷新
- 相关 Note：[工作区合并](./2026-10-12-workspace-merge.md)、[本地文档预览与文件监听](./2026-10-12-workspace-file-preview.md)

## 提案

- 编辑器采用 CodeMirror 6 + `@codemirror/lang-markdown`（Codex 桌面版同款选型），预览复用现有 `react-markdown` + `remark-gfm`，编辑/预览双态切换。
- 粘贴图片：编辑器监听 `paste` 事件，`clipboardData` 中含图片文件时调用 `workspace` IPC 把 PNG 写入当前文档同目录 `assets/<时间戳>-<原名>.png`，并在光标处插入相对链接（`\!\[\]\(assets/xxx.png\)` 形式，路径以 `assets/` 为前缀）；预览与 `answra-file://` 按相对路径解析。
- 外部变更刷新：收到 `changed` 推送且目标文档非「未保存编辑」状态时，重读文件并经 CodeMirror `dispatch` 全文替换（保留光标/选区折算）；有未保存编辑时弹冲突提示，由用户选择覆盖或放弃，不静默覆盖。
- 保存策略：输入防抖（约 800ms）自动写盘 + 手动保存快捷键；写盘失败在面板内显示错误。
- 明确不做：所见即所得混排编辑、表格编辑辅助、协同编辑。

## 影响表面

- 编辑体积增量约 1.2 MB（CodeMirror 全套按需引入），全部动态 `import()`，不影响应用启动路径。
- 测试需为编辑器提供 mock 桥与受控粘贴事件。

## 曾考虑的替代方案

- **沿用 textarea + 纯文本：** 实现最省，但无语法高亮、粘贴图片需手写光标管理，后续扩展性差，舍弃。
- **Monaco（VS Code 编辑器）：** 功能最强但体积 3 MB 以上且为浏览器 IDE 场景设计，悬浮条小面板过重，舍弃。
- **TipTap/ProseMirror 所见即所得：** 编辑体验好但保存为 HTML/JSON，与「md 文件落磁盘」的目标格式不匹配，往返转换易损内容，舍弃。

## 验收标准

- 可观察结果：md 编辑有语法高亮；粘贴截图后文档目录出现 `assets/` 图片且预览立即可见；外部编辑器修改文件后（无未保存编辑时）应用内内容自动刷新且光标大致保留。
- 自动化验证：`packages/ui/test/` 覆盖粘贴写盘路径拼接、相对链接插入、外部刷新的冲突保护分支。
- 需要的实机验证：Windows 剪贴板截图粘贴（截图工具/微信/浏览器复制图片）写入与展示。

## 风险

- CodeMirror 外部全文替换与用户输入竞态可能造成闪烁或光标跳动；以「未保存编辑优先」的冲突保护兜底。
- `assets/` 命名冲突（同秒同名）：文件名加时间戳与随机后缀。
- 防抖自动保存与外部变更推送交错时可能覆盖外部改动：写盘前比对内存基线 mtime，不一致走冲突提示。
