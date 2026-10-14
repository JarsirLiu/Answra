# Note：候选词窗口升级为全局光标浮层

状态：已实施

## 问题

候选词窗口原本渲染在 `ConversationComposer` 的 `<form>` 内部（absolute 定位），受面板容器裁剪与层叠上下文限制，观感上"困在对话面板里"，与系统输入法候选窗跟随光标的全局浮层行为不一致。

## 涉及范围

- 新增 `packages/ui/src/components/panels/ImeCandidateOverlay.tsx` / `.css`：portal 浮层与光标锚定。
- `packages/ui/src/components/panels/ConversationComposer.tsx`：改用浮层组件渲染候选窗。
- `packages/ui/src/components/panels/ImeCandidatePopup.css`：候选窗本体不再负责定位，只负责视觉。
- 测试：新增 `packages/ui/test/ImeCandidateOverlay.test.tsx`。

## 影响表面

- 用户可见：候选窗脱离对话面板裁剪，随输入光标定位，并在窗口底部空间不足时翻到光标上方。
- 输入交互：候选按钮点击不会夺走输入框焦点；焦点离开嵌入式 IME 输入框后候选窗隐藏。
- 复用范围：使用嵌入式 IME 的其他面板可复用同一浮层行为。

## 决定

1. 候选窗通过 `createPortal(…, document.body)` 渲染为 `position: fixed` 的全局浮层（z-index 1000），不受面板容器裁剪影响。
2. 锚点判定用 `focusin`/`focusout` 事件的 `event.target` 是否匹配 `[data-embedded-ime-target]`，比 `document.activeElement` 更直接（也规避了测试环境 activeElement 不更新的问题）。
3. 候选窗位置用镜像节点测量 textarea 内组合光标的视口坐标（复制字体/内边距/宽度等样式，量取 marker 的 offsetLeft/offsetTop），默认显示在光标行下方，贴近窗口底部时翻转到光标上方——与系统输入法一致；窗口滚动/缩放时重算。
4. 浮层容器 `mousedown` 阻止默认行为，点击候选按钮不会把焦点从输入框抢走导致浮层消失。

## 曾考虑的替代方案

- **独立透明 always-on-top BrowserWindow 当候选窗：** 完全模拟系统 IME 进程模型，但需要跨进程同步 ImeState、处理窗口定位与 DPI，复杂度高；当前所有 IME 面板都在同一 renderer 内，portal 浮层已达到同样的视觉与交互效果。
- **继续留在 form 内但提高 z-index：** 解决不了祖先 `overflow` 裁剪与层叠上下文隔离问题。

## 后果与防回退

- `ConversationComposer` 之外的 IME 面板（如 `ReplyConversationPopover`）无需改动即自动获得同样的浮层行为。
- 候选窗为浮层后，焦点离开输入框（focusout）即隐藏；键盘选词路径不受影响。
- 测试环境教训：React 挂载会清空 container 既有子节点，测试中手动创建的 textarea 必须在 `render` 之后再挂进 document；afterEach 不能手动删除 React 管理的 portal 节点（RTL 卸载时会报 removeChild NotFound）。
- 候选窗必须继续通过 portal 脱离可能裁剪它的面板祖先；不得只提高面板内 z-index。定位或可见性改动需保留 focusout、底部翻转和点击后焦点保持测试。

## 验证

- `pnpm --filter @answra/ui test`：14 个文件 102 个用例全部通过（含浮层 portal 断言：popup 在 container 之外、focusout 隐藏、mousedown 后浮层保持、enabled=false 隐藏）。
- `pnpm --filter @answra/ui typecheck`：通过。
