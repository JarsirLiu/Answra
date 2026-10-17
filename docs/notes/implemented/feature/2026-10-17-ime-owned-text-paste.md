# Note：内置 IME 接管时支持显式文本粘贴

状态：已实施

## 问题

内置 IME 通过将目标控件设为 DOM `readOnly`，阻止 Chromium 把键入交给 Windows 系统 IME。这个属性也阻止浏览器默认粘贴，因此用户无法在 IME 接管时粘贴文字。

## 涉及范围

- 代码/模块：`ConversationComposer`、`EmbeddedImeInput`、`RichTextComposer`、`MarkdownEditorPane`。
- UI/进程/协议/持久化表面：仅 renderer 输入行为，不改变 IPC、剪贴板权限或持久化契约。
- 相关 Note：[IME 权威会话与输入路由](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[工作区 Markdown 编辑器](./2026-10-12-workspace-markdown-editor.md)。

## 决定

保留 IME 接管时的 `readOnly`，继续阻止浏览器原生字符输入和系统 composition。仅在收到用户显式 `paste` 事件时接管纯文本：读取 `text/plain`，按当前编辑器选区调用受控文本替换、ProseMirror transaction 或 CodeMirror transaction。编辑器处理时取消浏览器默认粘贴，避免重复插入。

图片粘贴维持现有附件/图片落盘行为；图片文件优先走图片处理分支。`ConversationComposer` 和 `EmbeddedImeInput` 的业务只读/禁用状态不插入文本。未接管 IME 的目标继续使用编辑器原生粘贴。

## 影响表面

- 对话输入框、设置类受控文本框、TipTap composer 与 Markdown/CodeMirror 源码编辑器，在 IME 接管时支持显式纯文本粘贴。
- 选区替换、光标位置和受控值更新由各编辑器正式编辑 API 管理。
- 不通过临时解除 `readOnly`、合成键盘事件、改写 DOM value 或重新开放系统 IME 实现。

## 曾考虑的替代方案

- **IME 接管期间移除 `readOnly`：** 舍弃。会重新让 Chromium/Windows TSF 参与文本输入，破坏当前系统 IME 隔离目标。
- **模拟 Ctrl+V / 向 DOM 注入文本：** 舍弃。不能可靠地保留编辑器选区、受控状态与撤销历史，也可能绕过编辑器的事务模型。
- **继续禁止粘贴并要求关闭内置 IME：** 舍弃。显式粘贴不是系统 IME composition，编辑器已有正式事务 API 可处理，不必牺牲系统隔离。

## 后果与防回退

- IME 接管期间继续保持 `readOnly`；粘贴仅走显式 `paste` handler 和编辑器 API，普通字符事件不因此重新开放。
- 编辑器新增/替换粘贴处理时，必须区分图片文件与纯文本，并确保只有一个插入路径，防止重复粘贴。
- Windows 系统 IME 隔离仍需桌面实机确认；自动化测试不等价于 OS 行为验证。

## 验证

- `ConversationComposer`、`EmbeddedImeInput`、`RichTextComposer`、`MarkdownEditorPane` 相关测试：26 项通过，覆盖 IME 接管态选区替换、禁用态不插入、编辑器输入路由。
- `pnpm --filter @answra/ui typecheck` 通过。
- `pnpm notes:check` 通过。
- `git diff --check` 通过。
- Windows 实机验证：未执行；需确认系统 IME 未弹出、内置 IME 键入正常、纯文本粘贴一次且位置正确、截图粘贴仍正常。
