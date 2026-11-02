# Note：独立 Markdown 编辑器与系统文件打开

状态：已实施

## 问题

Answra 已有工作区 Markdown 源码编辑与预览，但它嵌在固定尺寸、透明、不可最大化的悬浮窗口中。用户希望在答题、会议之外，将 Answra 作为免费的 Markdown 编辑器，从系统文件管理器直接打开 Markdown，并在独立窗口中编辑。

## 涉及范围

- 代码/模块：`apps/desktop/src/main`（文档窗口、单实例文件路由、文件读写 IPC、系统文件关联）；`apps/desktop/src/preload`；`apps/desktop/src/renderer`；`packages/shared/src/channels/`；`packages/ui`；`apps/desktop/package.json`
- UI/进程/协议/持久化表面：新建常规 Electron 文档窗口；系统打开 `.md` 文件；文件读取、保存、外部变更提示；不改变工作区根目录与现有偏好。
- 相关 Note：[工作区 Markdown 编辑器](../../implemented/feature/2026-10-12-workspace-markdown-editor.md)、[工作区 Markdown 默认预览](../../implemented/feature/2026-10-13-workspace-markdown-default-preview.md)、[窗口表面生命周期](../architecture/2026-10-14-window-surface-lifecycle.md)

## 决定

- 新增标准可调整大小的独立文档窗口，支持最大化与系统全屏；窗口使用普通层级和焦点策略，不继承悬浮主窗口的透明、置顶和隐身免焦点行为。
- 注册 `.md` 文件关联，使 Answra 可被用户选择打开 Markdown；不主动覆盖系统默认应用。Windows 单实例启动参数和 macOS `open-file` 事件进入同一文件路由。
- 主进程在打开时校验扩展名并绑定绝对路径；renderer 通过该窗口的受限 IPC 读取和保存当前文档，不接受任意路径参数。工作区目录选择和缓存不参与。
- 复用现有 CodeMirror 6 与 Markdown 预览依赖；源码编辑器和预览能力动态加载，不新增编辑器/Markdown 依赖。
- 提供文件打开、保存、源码/预览切换、保存状态、外部修改冲突提示，以及 Ctrl/Cmd+S、撤销/重做等基础编辑能力。

## 影响表面

- 独立文档窗口与悬浮主窗口使用独立生命周期；文档窗口可调整大小、最大化和全屏。
- 文件系统入口经 Electron 文件关联、Windows `second-instance` 参数与 macOS `open-file` 事件进入同一文件路由；启动早期路径排队到应用就绪后处理。
- 绝对路径只由主进程从操作系统打开请求或可信文件选择框取得，并绑定到发起文档窗口；renderer 永不指定磁盘路径。
- 编辑器 UI 在 answer 与 full 打包配置中可用；CodeMirror 与预览栈按文档窗口需要加载。

## 曾考虑的替代方案

- **把文件父目录设为当前工作区：** 会覆盖用户已选择并缓存的工作区，违反工作区状态由用户显式选择的约束，舍弃。
- **继续在悬浮主窗口中显示编辑器：** 主窗口固定尺寸、透明且不可最大化，不适合长文写作；全屏时还会改变现有答题/会议交互，舍弃。
- **新增 Monaco 或所见即所得编辑器：** 会增加下载体积，且与现有 CodeMirror Markdown 保存为原始文本的路线重复，首版舍弃。
- **安装时将 Answra 强制设为默认 Markdown 应用：** 会覆盖用户选择并造成意外，舍弃；只声明可打开类型，由用户自行选择默认应用。

## 后果与防回退

- 文件关联分别通过 electron-builder 的 Windows `fileAssociations` 与 macOS 文档类型元数据声明；系统最终决定“打开方式”呈现和默认程序，未签名应用仍可能显示系统安全提示。
- 未签名应用仍可能显示 Windows SmartScreen 或 macOS Gatekeeper 提示；文件关联不绕过系统信任策略。
- 系统最终决定“打开方式”呈现和默认程序，安装或更新不会修改既有默认应用选择。
- answer profile 构建复用既有 Markdown/CodeMirror 依赖，未增加依赖项；安装包实际体积仍需按目标平台产物测量。

- 文件关联只让 Answra 可被选择打开 `.md`，不能在安装或更新时修改用户默认应用选择。
- renderer 不得传入任意文件路径；文件读写始终绑定主进程为文档窗口登记的路径。
- 文档窗口保持普通窗口层级与焦点策略，不加入主悬浮窗口的置顶或隐身免焦点策略。
- 编辑器与预览继续复用现有依赖，除非有单独的体积收益评估和决策记录，不引入重复解析器/编辑器依赖。

## 开发与发布 Profile

- 本地 `pnpm dev` 和 `pnpm dev:web` 默认使用 `full`，开发阶段解锁答题、聊天、面试和笔记本能力；仍可显式使用 `dev:answer` 复现发布版答题 Profile。
- GitHub Release 工作流调用 `dist:win` 与 `dist:mac`，两者都显式构建 `answer` Profile。该 Profile 保留 `workspace`，所以笔记本和独立 Markdown 编辑器持续开放，仅排除聊天与面试功能及其模型资源。
- Markdown 编辑器没有新增依赖；编辑器和解析器复用现有工作区依赖，避免安装包和更新包增加无关流量。

## 验证

- 自动化：Markdown 路径测试、窗口角色策略测试、UI 编辑器测试；`pnpm verify` 与 `pnpm notes:check` 通过。
- 构建：`pnpm --filter @answra/desktop build:answer` 通过；构建输出显示 Markdown/CodeMirror 复用现有模块，未新增依赖包。
- 尚未实测：Windows NSIS 与 macOS 安装包中的冷启动/已运行打开、文件关联 UI、最大化/全屏和保存流程；需分别在对应系统安装包验证。answer profile 构建不代表系统级文件关联已验证。

## 独立编辑体验修正

- 独立窗口的预览样式与工作区面板解耦；预览视口自行滚动，正文使用有最大宽度的阅读列，避免工作区 CSS 覆盖独立窗口布局。
- Markdown 中的本地图片引用按当前文档目录解析。renderer 只提交图片引用，主进程将路径限制在当前文档同目录树内，并返回图片 data URL；远程 HTTP(S) 图片沿用浏览器加载。
- 图片 IPC 不接受绝对路径或目录穿越；符号链接解析后仍须位于文档目录内。
- 替代方案：复用 `answra-file` 需要把任意独立文档目录引入工作区协议，扩大该协议的授权模型；新增流式协议会额外引入 scheme 生命周期和窗口身份映射。独立图片 IPC 保持能力只对文档窗口开放，适合本次窄范围预览需求。
- 验证证据：随本节更新的主进程路径测试和 UI 预览测试；最终执行记录以本次变更的门禁结果为准。
