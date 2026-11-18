# Note：设置里切换云端订阅未持久化

状态：已实施

## 问题

在设置中点击「云端订阅」后，界面会隐藏本地模型字段，但实际保存的来源仍是本地。用户答完题重新打开设置，看到的还是「本地模型」；这段时间的答题也仍然走本地端点。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/SettingsPanel.tsx`、`packages/ui/test/FloatingBarApp.settings.test.tsx`、`apps/desktop/src/main/conversation/modelSettings.ts`、`apps/desktop/test/modelSettings.test.ts`。
- UI/进程/协议/持久化表面：设置面板的模型来源切换与保存；共享 `config.json` 的 `model.source`；既有 `configureConversation` IPC 契约不变。
- 相关 Note：[答题本地扩展请求参数](../feature/2026-11-18-answer-provider-options.md)。

## 根因

1. `SettingsPanel` 的「云端订阅」按钮只调用 `setSource("cloud")`，没有调用 `configureConversation`。
2. 「保存」按钮只渲染在 `source === "local"` 分支里，云端来源没有提交入口。
3. 重新打开设置时 `getConversationConfig()` 读取的是持久化配置，来源仍是 `local`，于是界面回到本地；期间发送也继续使用本地端点。

## 修复

- 来源切换即生效：`selectSource(next)` 直接调用 `configureConversation({ source: next, ... })`，并用返回的视图回填来源、地址与模型。
- 本地地址或模型为空时只展开表单，不做无效写入；用户填完后由「保存」提交。
- 切换/保存期间禁用来源按钮，避免并发提交。
- 保存成功后同时回填规范化后的 `baseUrl`/`model`，不再只更新 `modelView`。
- 切换来源不清除本地 Key：云端模式不使用它，但保留在系统凭据库，切回本地可直接继续用；只有「清除」或显式迁移才删除。

## 决定

- 模型来源是显式选择，切换云端必须立即落盘；本地端点字段则保留显式保存。
- 渲染层不自行推断来源，只展示并提交主进程返回的视图。

## 曾考虑的替代方案

- **给云端分支也加一个「保存」按钮**：多一步且仍容易被忽略，用户已经认为切换本身应当生效；舍弃。
- **关闭面板时统一保存**：依赖关闭路径，崩溃或直接重开时仍会丢；舍弃。
- **主进程按登录态自动推断来源**：来源是显式选择，自动推断会覆盖用户意图；舍弃。

## 后果与防回退

- 云端切换保留本地 Key，不随来源切换删除；这是为了支持来回切换，不代表云端会读取它。需要撤销本地凭据时用「清除」。
- 未登录时切到云端仍会保存来源；下一次发送由既有 `canSend` 返回 `AUTH_REQUIRED`，设置面板不复制这套门禁。
- 来源按钮在提交期间必须禁用；否则连点可能产生以最后一次响应为准的竞态。
- 本地地址/模型为空时，切换只展开表单、不落盘；此时界面选中本地但实际仍未被使用，直到用户保存有效配置。这是唯一有意保留的“未立即切换”情形。

## 验证

- `pnpm --filter @answra/ui test -- FloatingBarApp.settings`：切云端后断言调用了 `configureConversation({ source: "cloud" })`；切回本地立即以 `source: "local"` 提交；修改模型 ID 后点保存再次提交。
- `pnpm --filter @answra/desktop test -- modelSettings`：切云端后本地端点与 Key 都保留。
- `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/desktop typecheck`。
- 待实机：登录后切云端 → 答题 → 重开设置，确认仍显示云端；再切回本地，确认无需重新输入 Key 即可发送。
