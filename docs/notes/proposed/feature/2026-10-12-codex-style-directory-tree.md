# Note：Codex 式工作区目录树与文件类型图标

状态：提案

## 问题

工作区面板左侧目录树与 Codex 桌面版差距明显：侧栏过窄（最宽 168px）、无文件筛选、缩进靠竖线、文件图标无类型辨识度。用户明确要求对齐 Codex 的目录树体验（紧凑行、纯缩进、每类文件彩色图标），并要求用成熟依赖而非手写映射。

## 涉及范围

- 代码/模块：`packages/ui`（`DirectoryTree` 筛选与图标、`DirectoryTree.css`/`WorkspacePanel.css` 样式，新增依赖 `vscode-icons-js`、`@iconify/react`、`@iconify-json/vscode-icons`）
- UI/进程/协议/持久化表面：仅渲染层目录树外观与筛选交互；不改动 IPC、workspace service 与文件读写

## 提案

- 图标：`vscode-icons-js` 提供"文件名/扩展名 → 图标名"映射（含 `.gitignore`、`.env.example`、`README.md` 等特殊文件），`@iconify/react` + `@iconify-json/vscode-icons` 离线渲染 VS Code 全套文件图标（覆盖 docx/pdf/xlsx 等办公格式）。图标集 JSON 以静态 `import` 在模块加载时经 `addCollection` 注册一次（曾用动态 `import()` 懒加载，实测在 Vite/Electron 下静默失败导致图标不渲染，改为官方离线静态用法保证确定性）。
- 筛选：树顶部加筛选输入框，按名称子串匹配；命中节点的祖先目录自动展开（覆盖手动展开状态），清除筛选后恢复。
- 样式：侧栏加宽至 `clamp(160px, 34%, 260px)`；行高 24px；子级缩进只用留白，去掉竖向缩进线；文件夹行只显示 chevron，与 Codex 一致。

## 曾考虑的替代方案

- **手写扩展名 → 彩色徽章组件（零依赖）：** 已实现过一版，但只能近似（TXT/PDF 等字母缩写），无法还原 VS Code 式图形图标；用户明确要求成熟包，故替换。
- **`file-icons-js`（Atom file-icons 图标字体）：** 映射覆盖广但包体积大、CSS 字体方案与现有构建不贴合，社区维护弱于 vscode-icons 生态，舍弃。
- **`react-arborist` 等树组件库替换自绘树：** 主要收益是虚拟滚动；当前目录树规模（个人文档目录）远未到需要虚拟化的量级，且替换会推翻现有新建/删除/筛选交互与测试，收益不成比例。目录过万时再引入。
- **Iconify 在线 API 模式：** 免本地 JSON 但依赖网络，桌面应用离线场景不可用，舍弃。

## 影响表面

- 新增三个纯前端依赖（无原生二进制）；`@iconify-json/vscode-icons` 的 `icons.json` 约 1 MB，懒加载后仅磁盘/内存成本，不占启动包。
- 筛选是纯渲染层行为，不触碰 workspace service 与 IPC。

## 验收标准

- 树中 md/docx/pdf/json/git 特殊文件显示对应的 VS Code 彩色图标；未知类型回退普通文件图标。
- 筛选框输入关键字后仅显示命中文件及其祖先目录，且祖先自动展开；清除后恢复原状态。
- 既有测试（`workspace.test.tsx` 的树结构/新建/删除断言）全部通过。

## 验证证据

- 待依赖安装与 `pnpm --filter @answra/ui typecheck && pnpm --filter @answra/ui test` 通过后转为已实施。
- 依赖均未原生编译，Electron 29 下无 ABI 风险。

## 风险

- `vscode-icons-js` 返回的图标名与 Iconify `vscode-icons:file-type-*` id 偶有不一致的可能；不一致时该文件回退普通文件图标，不影响功能。
- 图标集 JSON 体积约 1 MB，懒加载时机在树首次渲染，弱机首次打开面板可能有一次性几十毫秒解析开销。
