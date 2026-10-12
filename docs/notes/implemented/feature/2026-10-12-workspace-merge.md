# Note：笔记本与资料合并为本地工作区

状态：已实施

## 问题

当前「笔记本」是渲染进程 `localStorage` 里的单篇纯文本（`NOTE_STORAGE_KEY`），「资料」面板只是 `<input type="file">` 取文件名的内存数组（`SourcesPanel.tsx`），重启即丢，两者互不相通。用户需要一个真正的本地文档工作区：多级目录、md 文档可新建可编辑、doc/pdf 等资料可预览，全部落磁盘、不依赖应用内数据库。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/shared/src/bridge.ts`、`apps/desktop/src/main/ipc/`（新增 workspace 域 handler）、`packages/ui/src/components/panels/`（`NotesPanel`、`SourcesPanel` → 合并为 `WorkspacePanel`）、`packages/ui/src/app/FloatingBarApp.tsx`
- UI/进程/协议/持久化表面：悬浮条 `notes`/`sources` 两个面板入口、新增 `answra:workspace:*` IPC 频道、主进程文件系统访问、自定义 `answra-file://` protocol、磁盘持久化
- 相关 Note：[markdown 编辑与图片粘贴](./2026-10-12-workspace-markdown-editor.md)、[本地文档预览与文件监听](./2026-10-12-workspace-file-preview.md)

## 决定

- 面板层：保留 `OverlayMode` 的 `notes`/`sources` 两个入口值，两者都渲染同一个 `WorkspacePanel`（左目录树 + 右内容区），后续可再合并入口；不改 `OverlayMode` 字符串值，避免波及 windowIpc 与回复窗口同步链路。
- 数据层：用户首次进入面板时通过 `dialog.showOpenDialog` 选择一个工作区根目录；主进程把上次根目录缓存到 `userData/workspace.json`（仅存路径字符串），下次启动面板时若该路径仍存在则自动恢复，不再重复弹窗。
- IPC：`channels.ts` 新增 `WorkspaceChannels`：选择根目录（`pick-root`）、目录树（`list-tree`）、读文件（`read-file`，返回 base64 与文本双形态）、写文件（`write-file`）、创建目录/文档（`create-entry`）、删除条目（`delete-entry`）、文件变更推送（`changed`，主进程主动推）。请求/响应类型进 `WorkspaceChannelMap`。
- 安全边界：main 侧 handler 用 `isWindowFromSender` 校验来源；所有路径参数必须位于已授权根目录内（`path.relative` 前缀校验），拒绝越界读写，防止 IPC 被用于访问任意磁盘路径。
- 图片与预览资源加载：main 注册 `answra-file://` protocol（`protocol.handle`），只允许解析到已授权根目录内的文件；渲染进程不直接使用裸 `file://`。
- 明确不做（V1）：不建应用内索引/数据库、不搜索文件内容、不做 markdown 任务清单等结构化能力、不做云同步。

## 影响表面

- `NotesPanel` 与 `SourcesPanel` 被替换，`localStorage` 旧笔记（`answra-note`）一次性迁移：首次打开工作区面板时若检测到旧键非空且尚未迁移，写入工作区根目录 `未迁移笔记.md` 并保留 localStorage 原值（不删除，防丢失）。
- 主进程新增文件系统与 watcher 职责；renderer 仍不 import 任何 node/electron 模块，全部经 `DesktopBridge`。
- `FloatingBarApp` 中 `note`/`sources` state 及 `saveNote` 移除。

## 曾考虑的替代方案

- **彻底合并 `OverlayMode` 为单一 `workspace` 值：** 更干净，但 `OverlayMode` 已在 windowIpc、回复窗口状态同步、测试多处出现，牵连面大且无用户可感知收益；先共用面板、后合并入口，舍弃。
- **数据存 `app.getPath("userData")` 固定目录：** 无需选择根目录，但用户无法把文档放在自己的项目/网盘目录里，违背「走磁盘、用户可见」诉求，舍弃。
- **内置 SQLite 索引元数据：** V1 文件量小，直接枚举目录树足够；引入数据库增加迁移与一致性问题，舍弃。

## 验收标准

- 可观察结果：选择根目录后能看到目录树；可新建多级目录与 md 文档；md 可编辑并即时写盘；重启应用后文件仍在原目录。
- 自动化验证：`packages/ui/test/` 覆盖工作区面板的目录树渲染、文档打开/保存、旧笔记迁移；main 侧路径越界拒绝逻辑用 node:test/vitest 覆盖。
- 需要的实机验证：Windows 上验证 `answra-file://` 图片加载与 `isWindowFromSender` 来源校验不阻断正常面板。

## 后果与防回退

- 文件内容和工作区根目录由 main 进程落盘管理；renderer 只能通过类型化 `DesktopBridge` 操作，路径越界必须继续被拒绝。

## 验证

- `apps/desktop/test/workspaceService.test.ts` 与 `packages/ui/test/workspace.test.tsx` 覆盖核心读写、目录树、迁移和 watcher 行为。

## 风险

- 用户选择包含大量文件的目录（如整个用户目录）时枚举慢：V1 对目录树做懒加载（展开时才列子目录）缓解。
- 主进程拿到通配文件系统访问能力，若来源校验或路径前缀校验遗漏会成为安全隐患；以越界拒绝测试作为防回退约束。
- 旧笔记迁移写盘失败时需保留 localStorage 原值并提示，避免静默丢失。
