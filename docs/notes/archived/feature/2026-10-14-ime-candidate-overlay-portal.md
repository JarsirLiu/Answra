# Note：候选词窗口升级为全局光标浮层

状态：已实施
归档日期：2026-10-14

## 问题

最初候选条位于 `ConversationComposer` form 内，受 DOM 面板裁剪；portal 方案解除 DOM 裁剪，但仍受源 BrowserWindow 视口宽度限制，不能满足候选条独立于对话窗口的目标。当前方案已由[独立原生候选窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)取代。

## 涉及范围

- 历史代码：`packages/ui/src/components/panels/ImeCandidateOverlay.tsx`、候选浮层 CSS 和 overlay 测试。
- 历史影响：IME 候选条的 DOM 定位、输入焦点判定和 viewport 边缘翻转。

## 影响表面

- 历史用户行为：portal 候选条锚定 textarea caret，并在窗口底部空间不足时翻到 caret 上方。
- 历史输入行为：mousedown 阻止默认行为以保持输入框焦点；focusout 后隐藏候选条。

## 决定

- 历史实现使用 `createPortal(…, document.body)`、固定定位和 caret 镜像测量；锚点用 `focusin`/`focusout` 的 `event.target` 匹配 `[data-embedded-ime-target]`。
- 当时因跨进程状态同步、窗口定位和 DPI 处理成本，选择 portal 替代独立 BrowserWindow。后续用户明确提出系统输入法式独立候选条后，独立窗口成为满足目标的必要实现。
- 测试环境中 React render 会清空 container 既有子节点；手工创建的 textarea 应在 render 后挂入 document，portal 节点应由 RTL 卸载清理。

## 曾考虑的替代方案

- **候选窗使用独立 always-on-top BrowserWindow：** 当时需要增加候选状态 IPC、焦点保持和屏幕坐标处理，考虑到当时的范围和维护复杂度而暂缓；用户明确提出脱离面板窗口限制后，此方案被重新采用。
- **留在 form 内仅提高 z-index：** 无法解除祖先 overflow 裁剪，因此当时采用 portal。

## 后果与防回退

- Portal 方案只解决 DOM 裁剪，不代表独立于 BrowserWindow。后续若需要跨窗口边界，必须使用独立原生候选窗口。
- 独立候选窗的鼠标动作应由输入 owner renderer 处理，以保留 `onCommit` 和草稿更新。

## 验证

- 历史记录：portal 实施时 `pnpm --filter @answra/ui test` 有 14 个文件、102 项测试通过，包含浮层脱离 container、focusout 隐藏和 mousedown 保持焦点断言。
- 替代实现的当前验证见[独立原生候选窗口 Note](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)。
