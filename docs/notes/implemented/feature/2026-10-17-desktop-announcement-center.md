# Note：桌面端公告中心

状态：已实施

## 问题

网站管理员已能发布有效期、弹窗/静默类型和订阅目标公告，但桌面端没有公告入口，用户无法及时看到版本更新、福利或节日通知。

## 涉及范围

- 代码/模块：`packages/shared/src/{channels,bridge}.ts`、`apps/desktop/src/main/auth/`、`apps/desktop/src/preload/index.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、公告面板与测试。
- UI/进程/协议/持久化表面：账号 IPC 新增公告列表和标记已读操作；公告内容只在现有主窗口渲染，不使用系统通知或新建 BrowserWindow。
- 相关 Note：[桌面端账号登录与凭据](2026-10-17-desktop-account-login-and-credentials.md)、[主窗口与隐身边界](../architecture/2026-10-11-main-window-and-stealth-boundaries.md)。

## 决定

- 复用网关认证用户接口 `GET /api/v1/announcements` 与 `POST /api/v1/announcements/:id/read`。服务端继续负责有效期、用户可见性与 targeting，桌面不复制这些规则。
- main 使用内存 access token 请求并解包数据，只向 renderer 返回公告字段；token 不经过 IPC 响应。
- 登录后读取公告，运行期间每五分钟刷新未读状态；登出时清空公告。新增公告入口显示未读数，面板内可标记已读。
- `popup` 类型在面板中标为重要；不自动弹出正文，不调用 Windows/macOS 系统通知。用户查看内容时只在现有主窗口内渲染，因此继续使用已登记窗口的捕获保护，不新增原生窗口。
- 网站现有公告管理继续作为唯一发布入口。

## 影响表面

- 悬浮条：已登录账号显示公告入口，未读数有 badge；未登录隐藏入口。
- 公告面板：展示服务端可见公告的标题、正文、日期、未读状态和重要标记；标记已读后更新网关并同步本地 UI。
- 登录/登出：恢复或登录成功后加载公告，登出后清空列表。
- 后台创建或修改的公告通过原有网关接口影响桌面端，无需网站新增桌面专用 API。

## 曾考虑的替代方案

- **Windows/macOS 系统通知：** 通知由操作系统独立绘制，无法继承应用窗口的 `setContentProtection` 捕获策略，会议共享时可能暴露公告内容；舍弃。
- **新建公告 BrowserWindow：** 必须加入原生窗口注册和生命周期策略，遗漏任何注册路径都会绕过隐身保护；复用现有主窗口更容易维持已有保护约束。
- **自动弹出公告正文：** 会在隐身策略初始化时序内引入额外可见表面，并可能打断当前工作；采用 badge 提醒和用户主动查看。
- **在 renderer 直接请求网关：** 会把 access token 暴露给可能被截图或注入的 renderer；请求与凭据保持在 main。

## 后果与防回退

- 公告正文必须继续渲染在当前受保护主窗口中；不得切换到操作系统通知或无捕获保护的独立窗口。
- token 永不进 renderer、日志或 agent。IPC handler 需校验发送者属于主窗口。
- `notify_mode` 的 `popup` 只影响应用内重要标记，不授权系统级通知。
- 网关接口按账号返回公告，桌面端不可自行扩大目标人群或读取管理员公告 API。

## 验证

- `apps/desktop/test/authService.test.ts`：25 项通过，覆盖公告列表 envelope 解包、Bearer 请求、未登录短路、字段过滤和标记已读。
- `packages/ui/test/AnnouncementPanel.test.tsx`、`WorkspaceControls.test.tsx` 与 `FloatingBarApp.test.tsx`：41 项通过，覆盖公告展示、重要/未读状态、标记已读交互、登录态入口和原导航行为。
- 完整 `pnpm verify`：UI 220 项、桌面端 217 项、Agent 10 项测试通过；架构检查通过。
- 桌面端 main/preload/renderer typecheck 与 UI typecheck 通过；定向 Biome 检查通过。
- 待实机验证：Windows 11 与 macOS 上分别确认隐身开启时公告内容不进入目标会议软件的窗口/屏幕共享捕获。系统捕获工具对 Electron 内容保护的支持因平台而异。
