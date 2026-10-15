# Note：对话输入框改用 TipTap 可复用富文本组件

状态：已实施

## 问题

仓库需要可复用的富文本编辑能力，并需要在对话输入框粘贴图片时交给宿主附件流程。对话输入框同时由嵌入式 Rime 接管；Windows 实测日志表明 `contenteditable=true` 即使设置 `aria-readonly` 并拦截 composition 事件，系统 IME 仍会启动。因此对话 IME 输入继续使用原生只读 textarea；TipTap 组件保留为独立组件，供不承载 Rime 的编辑场景复用。

## 涉及范围

- 代码/模块：`packages/ui`（新增 `components/editor/RichTextComposer`，新增依赖 `@tiptap/react`、`@tiptap/core`、`@tiptap/pm`、`@tiptap/extension-document`、`@tiptap/extension-paragraph`、`@tiptap/extension-text`、`@tiptap/extension-hard-break`）；改 `ConversationComposer`、`ChatPanel`、`useEmbeddedIme`、`useStealthInputGuard`、`ImeCandidateAnchorReporter`、`ConversationComposer.css`
- UI/进程/协议/持久化表面：新增 `RichTextComposer`；`ConversationComposer`（ChatPanel 与 ReplyConversationPopover）仍使用 textarea 并在 paste 时调用宿主附件回调；IME 候选锚点继续使用 textarea mirror；对外数据契约不变（draft 仍是纯文本 string）

## 决定

- 新增可复用组件 `RichTextComposer`（`packages/ui/src/components/editor/`）：TipTap（ProseMirror）封装，纯文本模型（段落按 `\n` 与 draft string 双向同步），导出给宿主复用。该组件不作为当前 Rime 对话输入控件。
- 对话输入框保留原生 textarea。图片 paste handler 检测 `clipboardData.files` 中的图片，回调 `onPasteImages(files)` 交给 ChatPanel 现有附件通道；输入内容仍是纯文本，附件仍单独提交。
- Rime 接管期间 textarea 保持 `readOnly` 但可聚焦，物理键由 `keydown` 转发到 `ime.onKeyDown`，preedit 在 textarea 展示值中插入到 composition 开始时的 selection 位置；候选窗继续通过 textarea mirror 测量锚点。
- preedit widget 的稳定 key 必须包含当前 preedit 文本；否则 ProseMirror 会复用旧 DOM 节点，导致界面一直显示首个拼音字母。回归测试覆盖 `n` 更新为 `ni shi shui`。
- `useStealthInputGuard`、`useEmbeddedIme` 与 `ImeCandidateAnchorReporter` 围绕 `data-embedded-ime-target` 协作；Rime 输入目标仍是 textarea，以保留真实只读语义和 selection API。
- 外部 `inputRef` 继续指向 textarea，消息操作条聚焦后可显示系统 caret；Rime 提交按 composition 开始时记录的 selection 替换文本并恢复提交后的光标。

## 影响表面

- `packages/ui` 依赖增量约几百 KB（TipTap 核心 + 基础 node 扩展，未引入 StarterKit 全家桶）。
- `ConversationComposer` 的 `ime.onKeyDown` 参数维持 `React.KeyboardEvent<HTMLTextAreaElement>`。
- textarea 的图片粘贴在编辑器内不插入二进制内容，沿用宿主附件模型。

## 曾考虑的替代方案

- **用 contenteditable 承载 Rime 输入：** 实机日志显示系统 composition 仍会到达 DOM；ARIA readonly 和应用层 preventDefault 没有等价于原生 textarea `readOnly`，故当前对话输入不采用此方案。
- **用 textarea 处理图片 paste：** 采用。它可直接读取剪贴板文件并复用附件通道，不需要将图片节点写入文本编辑器。
- **CodeMirror 6：** 工作区 md 编辑器已用（见 2026-10-12 Note），但它本质是文本编辑器，contenteditable 级富内容（图片节点）与聊天输入场景不匹配，舍弃。
- **TipTap StarterKit 全量引入：** 附带 list/blockquote/history 等聊天输入用不到的能力与样式负担，改为最小 node 集合（Document/Paragraph/Text/HardBreak）。

## 验收标准

- 可观察结果：对话输入保持 textarea 只读接管、支持当前选区的 Rime preedit/提交、候选锚点跟随输入位置；粘贴截图触发附件通道；多轮回答只在当前流式正文显示回答光标。
- 自动化验证：对话输入测试覆盖 textarea readOnly、按键转发、选区 preedit、图片粘贴和提交；候选锚点测试覆盖 textarea mirror；ChatPanel 测试覆盖流式回答光标。
- 需要的实机验证：Windows 下内置 librime 不应启动系统候选 UI；候选定位、选区替换、提交后 caret、Stealth 截图排除仍需实测。

## 后果与防回退

- `RichTextComposer` 是单独的可复用编辑器，不得因其具备键盘拦截就推断可安全承载 Windows Rime 输入。
- Windows Rime 输入必须使用具备原生 `readOnly` 语义、可聚焦且可读写 selection 的控件；若再次采用 contenteditable，必须先证明系统 TSF 不会启动，并覆盖 Windows 实机测试。

## 验证

- 初始 TipTap 集成自动化通过，但 Windows 实机日志暴露 contenteditable 会收到系统 composition；修正后的 textarea 输入路径和 caret 行为由本次回归测试验证。Windows 实机复测列于上方，自动化结果不代替原生桌面验收。

## 风险

- contenteditable 可见 caret 不代表系统 IME 已被禁用；DOM 事件拦截发生时系统输入法可能已经启动。
- textarea 的候选定位依赖镜像样式和当前 selection；字体、缩放或多行换行变化需通过实机确认。
