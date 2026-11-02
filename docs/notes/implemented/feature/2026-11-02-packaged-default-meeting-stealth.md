# Note：打包版默认开启会议隐身

状态：已实施

## 问题

会议隐身设置此前仅在 localStorage 保存值为 `on` 时启用。新安装没有该值，打包版首次启动会以普通模式运行，用户需要先进入设置手动开启，与应用的会议隐身定位不符。

## 涉及范围

- 代码/模块：`packages/shared/src/bridge.ts`、`apps/desktop/src/preload/index.ts`、`packages/ui/src/hooks/useMeetingStealth.ts`、`packages/ui/test/FloatingBarApp.test.tsx`
- UI/进程/协议/持久化表面：preload 向 renderer 提供打包态；renderer 首次解析会议隐身本地偏好。未增加 IPC 频道或安装资源。
- 相关 Note：[会议场景隐身模式的窗口与捕获边界](../../proposed/architecture/2026-10-13-comprehensive-stealth-mode.md)

## 决定

打包版首次启动默认启用会议隐身；若本地已有 `on` 或 `off`，用户选择优先。开发态和浏览器预览在没有偏好时仍默认关闭。preload 使用现有 `--answra-packaged` argv 标记暴露 `isPackaged`，UI 不借用面试可用性字段推导打包状态。

隐身能力检测仍由现有系统 API 流程决定是否向主进程同步开启状态。打包默认不代表捕获软件必然遵守系统排除标志；行为限制见相关架构 Note。

## 曾考虑的替代方案

- **每次启动都强制开启：** 舍弃。会覆盖用户在设置中明确关闭的选择。
- **用 `interviewAvailable` 推导打包态：** 舍弃。功能可用性与打包状态是不同事实，不能把一个字段当作另一个状态来源。
- **开发态也默认开启：** 舍弃。开发与浏览器预览继续保持原有默认，避免测试环境和开发工作流意外禁用文本输入。

## 影响表面

- 全新安装的打包版启动时，会议隐身开关与 renderer 隐身约束均为开启状态；能力检测通过后通知主进程应用现有窗口策略。
- 已明确保存 `off` 的用户仍以关闭状态启动；保存 `on` 的用户仍以开启状态启动。
- 浏览器预览、没有打包标志的测试和开发态保持关闭默认。

## 后果与防回退

- 新安装不会静默以普通模式启动；用户关闭设置后会写入 `off`，后续启动尊重该选择。
- `DesktopBridge.isPackaged` 是 preload 暴露的构建事实；若打包参数变更，preload 与主窗口 argv 必须同步更新。
- 会议隐身依赖系统捕获保护能力，不承诺所有会议或录屏软件都遵守排除标志。

## 验收标准

- 自动化验证：UI 测试覆盖打包版无偏好默认开启、显式 `off` 优先以及开发/预览默认关闭。
- 自动化验证：`pnpm notes:check`、`pnpm verify`。
- 实机验证：本次只调整首次启动偏好解析；Windows/macOS 系统捕获行为仍需按相关隐身架构 Note 的实机矩阵验证。

## 验证

- `FloatingBarApp.test.tsx` 覆盖打包默认开启、用户关闭覆盖和未打包环境默认关闭；该文件 47 项测试通过。
- `pnpm notes:check` 通过。
- `pnpm verify` 通过：Biome 检查、全包 typecheck、全量测试（584 项）和架构检查均通过。
