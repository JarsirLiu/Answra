# Note：恢复 Rime 只读输入与对话光标

状态：已实施

## 问题

对话输入迁移为 TipTap 后，编辑器仍以 `contenteditable=true` 接受焦点。`aria-readonly` 仅提供无障碍语义，ProseMirror 的 `handleTextInput` 和 composition 事件拦截不能阻止 Windows TSF 启动系统输入法。用户日志出现 `system composition blocked` 和 `unexpected native composition blocked`，证明原生组合事件已进入 renderer。另有两处 caret 行为错误：主对话没有向 assistant 消息传入流式 caret；Rime commit 回调无视 textarea selection，总把提交文本追加到草稿尾部。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ConversationComposer.tsx`、`ImeCandidateAnchorReporter.tsx`、`ChatPanel.tsx`、`ReplyConversationPopover.tsx` 与 UI 测试。
- UI/进程/协议/持久化表面：Windows 原生 IME 与 renderer 输入控件边界、Rime 文本提交、候选窗锚点、流式回答显示。
- 相关 Note：[对话输入框 TipTap 组件及 Rime 兼容边界](../feature/2026-10-15-tiptap-composer-editor.md)、[输入法组合期间候选状态只能暂停，不能清除](./2026-10-14-ime-composition-suspend.md)。

## 根因

`contenteditable=true` 配合 `aria-readonly=true` 不等价于 textarea 的原生 `readOnly`。应用层取消 composition 事件只能拦截 DOM 提交，不能证明 Windows 系统 IME 没有先接管按键或显示候选 UI。与此同时，`ChatPanel` 只传递 `streaming` 而漏传 `AssistantMessage.caret`。IME 提交回调只拿到文本并直接拼接到 draft 末尾，也没有保存组合开始时的选区。

## 决定

在 Rime 接管的对话输入中优先保留可验证的原生只读输入行为和 textarea selection；共享富文本组件继续独立存在。修复提交位置和候选锚点时使用 composition 开始时记录的真实选区，并补齐当前流式消息的回答 caret。

## 修复

- 对话 composer 恢复可聚焦的原生 textarea；Rime 存在时保持 `readOnly`，物理按键继续转发给 librime。独立 `RichTextComposer` 保留导出，但不承载当前 Rime 输入。
- textarea 显示值在 composition 起始选区插入 preedit，并把 caret 放在 preedit 后；候选窗锚点恢复 textarea mirror 测量，按当前 selection 和 preedit 长度定位。
- 主对话和回复对话在 composition 开始时保存 selection 范围。librime 返回 commit 后，替换该范围并在提交文本后恢复 caret；普通 Rime Backspace 也按当前 selection 删除。
- ChatPanel 仅向当前正在流式输出且已有正文的 assistant 消息传入 caret。
- textarea 粘贴图片仍由宿主附件回调处理，不影响文本模型。

## 曾考虑的替代方案

- **继续用 contenteditable 并依赖 `preventDefault`：** 舍弃。用户日志已观察到原生 composition 事件进入 DOM；这不能满足阻止系统 IME 启动的输入边界。
- **把 Weasel TSF 直接移植到 renderer：** 舍弃。Weasel 的 `ITfContext`、edit session 和 `GetTextExt` 属于 Windows TSF text service；Electron renderer 使用 DOM/IPC，不能直接复用这些对象。可借鉴的是按真实 selection 管理组合范围和候选锚点。
- **继续把 commit 追加到 draft 末尾：** 舍弃。它与可见 caret/selection 脱节，选中已有文字时也无法正确替换。

## 后果与防回退

- Rime 输入目标必须保留原生 `readOnly` 语义、DOM focus 与 selection API；ARIA 标记或 composition 事件拦截不得作为系统 IME 已禁用的证据。
- commit 的 selection 范围在 composition 起始按键时保存，候选点击选择也使用同一范围；提交之后 caret 必须落在 commit 文本之后。
- assistant 回答 caret 只在最新流式消息有正文时显示；思考阶段和已完成历史消息不显示。
- 隐身模式捕获保护作用于受保护窗口的内容。输入 caret 属于窗口内容；目标 Windows 版本和截图 API 仍需实机验证，不能仅由 UI 自动化推断捕获结果。

## 验证

- 自动化覆盖 textarea readOnly、物理键转发、caret 处的 preedit、图片粘贴、textarea mirror 锚点恢复，以及主对话流式 caret 的显示/移除。
- 必须在 Windows 实机验证：系统 IME 候选 UI 不再出现；Rime 在中间 caret 处组词、选区替换、提交后 caret 和候选锚点正确；隐身截图不包含输入窗口 caret。
