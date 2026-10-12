# Note：工作区 PDF 预览加载与阅读区域

状态：已实施

## 问题

工作区打开 PDF 后可能一直显示解析中，画布为空，无法区分无效字节、worker 故障和解析超时。用户提供的日志显示文件数据已完整传到 renderer，卡在 PDF worker 与文档加载之间。右侧阅读区域需要由用户手动调整文档比例；扩大整个工作区并非文档缩放。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/PdfPreviewPane.tsx`、`WorkspacePanel.tsx`、`WorkspacePanel.css`、`apps/desktop/src/main/mainWindowController.ts`
- UI/进程/协议/持久化表面：PDF worker 加载、PDF 画布状态、文档缩放
- 相关 Note：[本地文档预览](../feature/2026-10-12-workspace-file-preview.md)、[目录分栏与 DOCX 预览](./2026-10-12-workspace-docx-preview-layout.md)

## 根因

原实现把 worker 的创建和故障处理完全交给 `getDocument`，没有独立记录 worker 错误。补上错误监听后，真实日志确认 PDF.js worker 因 `Promise.try is not a function` 崩溃：`pdfjs-dist 5.7.284` 使用了 Electron 29（Chromium 122）尚不支持的 API。文件长度为 302,854 字节，磁盘与 renderer 字节数一致，且具有 `%PDF-1.7` 文件头和 `%%EOF` 结尾。对照本机 Codex 桌面端，它运行在 Chromium 155，显式创建 module Worker、把端口交给 `PDFWorker.create` 并监听 worker 的 `error`；旧 Chromium 需要在 renderer 和 worker 两侧补 `Promise.try` 兼容。

## 决定

- 通过 `pdfjs-dist/build/pdf.worker.min.mjs?url` 让 Vite 输出 worker 资产，以当前页面 URL 解析 worker 地址；显式创建 module Worker 并通过 `PDFWorker.create({ port })` 交给 PDF.js。页面 origin 为 `null` 或 worker 跨源时用 Blob module wrapper 导入，以兼容 Electron file origin。
- 监听 worker `error`，在启动日志中记录阶段与错误，避免 worker 崩溃仅表现为永久解析中；继续验证 PDF 文件头并对加载和渲染设置超时。
- 在 renderer 导入 PDF.js 前、以及 worker module 动态导入前补齐 `Promise.try`，兼容 Electron 29 所带的旧 Chromium；仅在缺少原生实现时安装。
- PDF.js 解析 30 秒仍未结束时显示超时错误；解析异常展示具体信息，画布仅在成功后显示。
- PDF 诊断日志输出文件路径、字节数、worker URL、解析阶段、进度、页数和异常堆栈；Electron main 同时把 `[workspace][pdf]` renderer 日志转发到启动终端。
- PDF 工具栏提供 50% 至 200% 的手动缩放和重置，按设备像素比渲染，文档较宽时由预览区域滚动查看。
- 删除无效的整面板放大按钮，为缩放、文件头校验和错误反馈增加 UI 回归测试。

## 修复

使用 Vite `?url` 静态资源导入，并把 worker 地址解析为基于页面的绝对 URL。显式创建并监听 module Worker，再将 worker 端口传给 PDF.js；对 file origin、跨源 URL 或缺少 `Promise.try` 的运行环境使用 Blob 动态导入 wrapper，并在 renderer/worker 两侧补齐该 API。解析前校验 PDF 文件头前 1KB；解析失败和超时均显示明确状态并记录阶段日志，Electron 主进程正确读取 Electron 29 的 `console-message` details 参数并转发日志。首张页面渲染完成后即可显示，不等待整个多页文档渲染。PDF 页面缩放由独立控件驱动并重新渲染，面板布局不再提供扩展窗口的控件。

## 影响表面

PDF 阅读、worker 资源打包和页面缩放交互。

## 曾考虑的替代方案

- **关闭 PDF.js worker 使用主线程解析：** 可绕开 worker URL，但大文件会占用 renderer 主线程并冻结 UI，舍弃。
- **只向 renderer 控制台写日志：** 用户需要额外打开开发工具且容易遗漏；转发具名日志到启动终端更便于定位实际桌面构建问题，舍弃。
- **使用系统 PDF 窗口：** 无法在工作区内与目录并排查看，且切换应用打断资料浏览，舍弃。
- **扩大整个工作区模拟 PDF 放大：** 不改变 PDF 页面比例，且窗口控制并不可靠，舍弃；缩放应作用于页面本身。

## 验收标准

- 可观察结果：PDF 文件头不合法时显示原因，解析超时退出永久加载；缩放按钮改变页面渲染比例。
- 自动化验证：UI 测试验证 PDF 字节、成功/失败状态、文件头错误和缩放比例；运行 `pnpm notes:check` 与 `pnpm verify`。
- 需要的实机验证：Windows 桌面构建打开用户 PDF，检查 worker 运行、中文多页滚动和缩放。

## 后果与防回退

PDF.js worker 必须经 bundler 资产导入并解析为绝对 URL，禁止再用包路径字符串推导生产 URL。PDF 状态提示和画布容器需互斥显示；解析必须有错误或超时出口；缩放应修改 PDF 页面比例，不应依赖窗口尺寸变化。

## 验证

用户 PDF 在磁盘和 renderer 中均为 302,854 字节，具有 `%PDF-1.7` 文件头及 `%%EOF` 结尾。用户日志确认根因是 pdfjs worker 在 Electron 29 Chromium 122 中调用未实现的 `Promise.try`。已在 renderer 导入 PDF.js 前补齐该 API，并在旧运行时通过 Blob bootstrap 在 worker 导入前补齐；UI 测试覆盖旧运行时和 worker bootstrap。`pnpm verify`、`pnpm --filter @answra/desktop build` 均通过。仍需在 Windows Electron renderer 中重新打开该 PDF，确认真实 worker 完整解析和页面渲染。
