# Note：原生 title 悬停提示破隐身——全局禁用并引入隐身门控的自制提示

状态：已实施

## 问题

用户实测发现：隐身模式（会议防偷窥）下把鼠标悬停在图标控件上，会弹出原生 `title` 提示文案（截图场景为公告工具栏「全部已读」），提示由操作系统/Chromium 直接渲染入画，屏幕共享/截屏时直接暴露产品 UI——破除隐身。用户要求：图标控件必须仍然"可理解"，但隐身模式下**绝对不能**出现任何悬停提示。

事实认定：
1. 原生 `title` 提示由浏览器合成层渲染在窗口之上，CSS 与 JS 均无法按隐身状态关闭，也无法定制样式——它是比"贴边灰环"更基础的腐化源，**不可能通过门控修复，只能整体移除**。
2. 隐身状态的权威来源在应用层（`FloatingBarApp` 的 `useMeetingStealth` → `data-stealth`），ui 包内组件此前拿不到全局订阅。
3. ui 包现存 20+ 处 DOM `title` 属性（公告工具栏、缩放控件、发送条、工作区、密钥显隐等），全部是潜在泄漏点。

## 涉及范围

- 代码/模块：全部 ui 包组件的 DOM `title` 属性清除（约 12 个文件）；新增 `packages/ui/src/components/controls/Tooltip.tsx` + `Tooltip.css`（自制气泡 + 隐身门控）；`FloatingBarApp` 植入 `TooltipProvider`。
- UI 行为变化：悬停在原来带 title 的控件上不再出现 OS 提示；非隐身状态下，高歧义 icon-only 控件出现自制小气泡（300ms 延迟、跟随控件上方、越界钳制）。
- 相关 Note：[公告工具栏与定高列表](2026-10-31-announcement-toolbar-clear-read-and-fixed-height.md)——该 Note 的约束一写过"icon-only + tooltip"，其中 tooltip 的实现从本 Note 起改判为"自制门控气泡"；其余语义不变。
- 协议/进程：无 IPC 变化；隐身状态沿用 `localStorage` + `useMeetingStealth`，气泡组件经 React Context 读取。

## 决定

1. **全局禁令**：ui 包内任何元素不得挂 DOM `title` 属性；评审与 Code Review 按本 Note 阻断。无障碍名称一律走 `aria-label`（屏幕阅读器不往画面里加东西，不破隐身）。
2. **自制门控气泡 `Tooltip`**：`<Tooltip label="...">单元素按钮</Tooltip>`；hover/focus 300ms 后在控件上方弹出应用内气泡（`aria-hidden`、`pointer-events:none`、portal 到 body、z-index 1100、水平越界钳制、页面滚动即消失）。
3. **隐身 fail-closed**：Context 缺省值为"隐身"——未接入 `TooltipProvider` 的调用面永远不出气泡；`TooltipProvider` 由 `FloatingBarApp` 以 `stealthSetting.enabled` 注入，隐身切换即刻生效（显示中气泡也会即时收回）。
4. **信息迁移规则**：原 title 是控件唯一说明的，迁移路径为 `aria-label`（保底）+ 需要视觉理解的 icon-only 控件再加 `Tooltip`；已有可见文字或 aria-label 的，title 直接删除。disabled 按钮的原因文案（如"回复完成后才能清空"）迁入 `aria-label`——disabled 元素不派发鼠标事件，自制气泡不启动，这是接受的信息损失（透明可见性以隐身安全为准）。

## 修复

- 清除全部 DOM title（AccountPanel/AnnouncementList/ChatPanel/ConversationComposer/InterviewCapturePanel/SettingsPanel/WorkspacePanel/ZoomablePreview/ReplyActivityTicker/PanelShell/TextResponse）。
- 新增 Tooltip 控件与 Provider，应用到 icon-only 高歧义控件：公告工具栏两钮、密钥显隐、麦克风监听、工作区侧栏与更换目录、缩放控件、附件/发送、清空对话。

## 曾考虑的替代方案

- **保留原生 title、隐身时写 JS 移除属性：** 舍弃。需要全包响应隐身切换做属性清理，且失去样式与延迟控制；自制气泡一次到位。
- **hover 前置可见文字标签（每钮配文字）：** 与用户上一轮"禁止文字按钮"冲突，且浮条密度不允许。
- **什么都不做、依赖 aria-label：** 舍弃。普通用户不接屏幕阅读器，图标含义不可发现，违背用户"要能理解控件"的诉求。
- **气泡样式走系统 title 外观：** 不可能——原生 title 不受 CSS 控制，这正是要移除它的原因。

## 后果与防回退

- 约束一：新增控件需要悬停说明时，只能用 `Tooltip`（门控气泡），谁写 DOM `title` 谁回滚。
- 约束二：Tooltip 的 Context 缺省必须保持 `true`（fail-closed）；新入口忘接 Provider 的代价是"没有提示"，而不是"隐身破防"。
- 约束三：disabled 控件无悬停解释是接受的行为，不要用"hover 显示原因"的名义往 disabled 元素挂 title。
- 约束四：`themeCss` 对 Tooltip.css 走调色板令牌守卫（无硬编码色值）。

## 验证

- 新增 `packages/ui/test/Tooltip.test.tsx`：非隐身 hover 300ms 出气泡、隐身/未接 Provider 时不出、气泡隐藏链接（click 内部无 title 泄漏）；`AnnouncementList.test.tsx` 补断言工具栏按钮无 `title` 属性。
- 全 ui 测试（含既有 FloatingBarApp/WorkspaceControls 相关）保持绿；`themeCss.test.ts` 守卫扩展 Tooltip.css。
- 实机（用户目测）：非隐身悬停出应用内气泡；开启隐身后悬停无任何提示；截屏/共享画面中不再出现悬停文案。
