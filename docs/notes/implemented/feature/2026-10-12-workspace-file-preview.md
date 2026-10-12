# Note：本地文档预览（docx/pdf/md 代码高亮）与文件监听

状态：已实施

## 问题

工作区中的 docx、pdf 资料需要应用内预览，md 预览的代码块需要语法高亮；目录下文件被外部程序（其他编辑器、下载完成等）改动后，打开的预览需要自动刷新。经对 Codex 桌面版（MSIX 安装目录 `THIRD_PARTY_NOTICES.txt`）实证，其预览栈为 `docx-preview`、`pdfjs-dist`、`marked`/`micromark`、`shiki`、`@parcel/watcher`，全部为纯前端方案，无内置 Office 或外部进程转换，本提案沿用同一技术路线。

## 涉及范围

- 代码/模块：`packages/ui`（新增预览组件，新增依赖 `docx-preview`、`pdfjs-dist`、`shiki`）；`apps/desktop/src/main`（用 Node 内置 `fs.watch` 做根目录递归监听与 `changed` 推送，无额外原生依赖）
- UI/进程/协议/持久化表面：工作区面板内容区三种预览态；`answra-file://` protocol 承载图片/PDF 资源；主进程 watcher 生命周期
- 相关 Note：[工作区合并](./2026-10-12-workspace-merge.md)、[markdown 编辑与图片粘贴](./2026-10-12-workspace-markdown-editor.md)

## 决定

- docx：`docx-preview`（约 0.3 MB 含 jszip）在渲染进程把 ArrayBuffer 渲染为 HTML，样式限定在工作区内容容器内避免污染全局。
- pdf：`pdfjs-dist` 渲染到 canvas（主库 + worker 约 3 MB）；worker 与主库均动态 `import()`，首次打开 pdf 才加载。
- 统一缩放：所有预览（docx/pdf/txt/md/图片）共用 `ZoomablePreview` 容器，工具栏 + CSS `zoom` 做网页式缩放（不重读/不重渲染文档）；docx/pdf/图片在内容就绪后自动适应宽度。txt/json 走 `TextPreviewPane` 纯文本预览（`white-space: pre-wrap`）。
- 代码高亮：`shiki` 细粒度引入（常用语言 + 1–2 主题，约 3 MB），仅用于 md 预览代码块，动态加载。
- 文件监听：main 对已授权根目录用 Node 内置 `fs.watch` 做逐层递归监听（启动时遍历目录树为每个子目录挂监听，新建子目录时补挂），事件合并防抖（约 300ms）后经 `WorkspaceChannels.Changed` 推送 `workspace://` 变更路径列表；renderer 按路径刷新目录树与打开的预览/编辑器。切换根目录时重建 watcher，面板关闭即销毁。
- 明确不做：编辑 docx/pdf、文档内容全文检索、缩略图缓存、旧版 `.doc`（OLE2 二进制，纯前端无法解析，提示另存为 `.docx`）。

## 影响表面

- 打包体积增量约 +9–13 MB（磁盘），安装包压缩后约 +5–7 MB；三项重依赖全部懒加载，启动体积不变。
- 文件监听零额外依赖，不引入原生 `.node` 二进制，electron-builder 只打包业务代码，安装包不含 watchman/parcel 等外部原生件。

## 曾考虑的替代方案

- **Electron 内置 `fs.watch` 递归：** 零依赖、Windows 可用；事件粒度粗、无内置防抖合并、Linux 不支持 `recursive`，故实现为手动逐层 watch + 300ms 合并。`@parcel/watcher` 虽为 Codex 同款，但其在 Electron 29 下出现 `watch is not a function`（v2 API 改名 `subscribe`）及原生二进制加载问题，最终弃用、改用 `fs.watch`。
- **系统默认程序打开（`shell.openPath`）：** 实现最省，但脱离应用、无法与工作区状态联动，只作为预览失败时的兜底按钮保留，舍弃为主方案。
- **pdf 走 `<iframe src="answra-file://...">` 让 Chromium 内置查看器渲染：** 省去 pdfjs-dist，但外观不可控、无法限制资源访问行为，舍弃。

## 验收标准

- 可观察结果：docx 显示分页样式内容、pdf 渲染清晰可缩放、md 代码块带主题高亮；外部改动文件后预览在约 1 秒内刷新。
- 自动化验证：main 侧 watcher 事件 → 防抖 → 推送的转换逻辑用临时目录集成测试；ui 侧预览组件按文件类型分派。
- 需要的实机验证：Windows 上打开含中文文件名的 docx/pdf、外部（Word/浏览器下载）改动后刷新、大目录（万级文件）watcher CPU 占用。

## 后果与防回退

- docx/pdf 解析按需加载，watcher 只推送授权根目录内的相对变更；原生依赖和复杂文档排版仍需 Windows 实机验证。

## 验证

- workspace service 测试覆盖 watcher 事件转发和切换根目录，UI 测试覆盖文件类型分派与打开流程。

## 风险

- `@parcel/watcher` 原生二进制与 Electron ABI 无关（独立进程/原生模块），但仍需在打包后实机验证加载路径。
- 大目录监听 CPU/内存开销：懒加载目录树 + 仅监听已授权根目录；出现瓶颈时退回按需监听子目录。
- docx-preview 对复杂排版（公式、SmartArt、复杂表格）还原度有限，接受为已知限制，提供「系统程序打开」兜底。
