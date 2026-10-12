# Note：模型设置 API Key 显隐与统一保存控件

状态：已实施

## 问题

模型设置中的 API Key 始终以密码文本显示，用户无法确认输入内容；保存操作使用原生按钮，未遵循悬浮表面的统一按钮契约。此外主进程从不返回已保存的 Key（`getConfig` 剥离 apiKey），保存成功后输入框清空且无成功反馈，用户误以为保存失败，也无法查看已保存的 Key。

## 涉及范围

- 代码：`packages/ui/src/components/panels/SettingsPanel.tsx`、`SettingsPanel.css`
- 跨模块契约：`packages/shared/src/channels.ts`（新增 `GetApiKey` 频道）、`packages/shared/src/bridge.ts`（新增 `getConversationApiKey`）、`apps/desktop/src/main/conversation/appService.ts`（新增 `getApiKey`）、`conversationIpc.ts`（新 handler）、`apps/desktop/src/preload/index.ts`
- 用户行为：模型设置中的密钥显隐、按需回显和配置保存操作
- 验证：`packages/ui/test/FloatingBarApp.test.tsx`

## 决定

1. API Key 输入框增加眼睛图标切换显隐，默认隐藏，并通过 `aria-label` 和 tooltip 说明当前操作。保存操作统一使用 `SurfaceButton` 的 `primary` 变体。
2. 保存成功后输入框按安全惯例清空（Key 不常驻 renderer 状态），但状态栏用品牌绿显示"已保存"2.5 秒，替代静默清空。
3. Key 回显采用**按需拉取**：新增 `answra:conversation:get-api-key` IPC（来源校验与其他 handler 一致），仅当用户点眼睛显示、且输入框为空时，才向主进程拉取 `safeStorage` 解密后的 Key 填入输入框；主进程不随配置查询自动下发明文 Key。输入框已有内容时切换显隐不重复拉取。

## 影响表面

设置面板新增仅影响当前输入框的显隐控制与"已保存"状态反馈；`DesktopBridge` 新增可选 `getConversationApiKey`（浏览器预览/测试可未实现）。保存、禁用和错误处理流程不变。

## 曾考虑的替代方案

- **继续使用原生按钮并补充 CSS：** 会绕过 `SurfaceButton` 的统一控件契约，后续主题和状态容易再次分叉，舍弃。
- **使用文字"显示/隐藏"按钮：** 占用更多设置面板空间且不符合常用密钥输入控件习惯，采用眼睛图标并补充无障碍名称。
- **默认显示 API Key：** 增加误曝光风险，与密码输入的默认行为不符，舍弃。
- **打开设置面板即自动回显 Key：** 明文会常驻 renderer 内存并出现在 `getConfig` 响应里，暴露面大；改为点眼睛才拉取，按需、显式、一次一轮 IPC，采用。
- **只回显掩码（尾 4 位）：** 无需新 IPC 但用户看不到完整 Key，无法在换机/排查时核对，且仍需 IPC 才能拿到掩码；用户明确要求完整回显，舍弃。

## 后果与防回退

显隐与回显只改变当前输入框的渲染内容，不改变 API Key 的持久化和 `safeStorage` 加密流程；明文 Key 只在用户点眼睛时经一次 IPC 进入 renderer。设置面板中的业务按钮不得重新使用原生按钮外观；图标按钮必须提供可访问名称；不得在 `getConfig` 响应中附带明文 Key（回显必须走独立的 `GetApiKey` 频道）。

## 验证

`pnpm --filter @answra/ui test` 通过（52 个用例，含"保存后显示已保存反馈并清空输入框""点眼睛按需拉取已保存 Key 回显、已有内容不重复拉取"两条新用例）。
