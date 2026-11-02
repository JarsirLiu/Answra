# Note：答题版 renderer 大 chunk 与 Markdown 动态导入警告

状态：已实施

## 问题

答题版 renderer 构建存在超过 500 KB 的 JavaScript chunk。工作区 chunk 将完整 VS Code 图标 JSON（约 3.84 MB）打入脚本；主入口约 1.12 MB。此前聊天正文静态引用 Markdown 解析器，而工作区和独立编辑器又动态引用同一依赖，构建器报告动态导入无法拆分。

## 涉及范围

- 代码/模块：`packages/ui` 的 Markdown 渲染运行时和工作区目录树；`apps/desktop` 的 Vite renderer 资源插件与 Rolldown chunk 配置。
- UI/构建表面：聊天、工作区预览、独立 Markdown 编辑器的解析器加载；工作区打开时的 VS Code 图标资源加载；answer/full renderer 产物布局。
- 相关 Note：[独立 Markdown 编辑器与系统文件打开](../feature/2026-11-02-standalone-markdown-editor.md)、[目录树 VS Code 图标方案](../../proposed/feature/2026-10-12-codex-style-directory-tree.md)。

## 根因

- 聊天正文静态导入 `react-markdown` 全家桶，工作区预览与独立编辑器又动态导入同一模块图，Rolldown 无法把同一依赖稳定拆成动态 chunk，构建器报告动态导入无法拆分。
- 主入口没有 vendor 分组，`react-dom`、KaTeX、TipTap/ProseMirror、AI SDK/zod 全部落入入口 chunk，压缩后约 1.12 MB。
- 目录树在模块顶层静态导入完整 VS Code 图标 JSON，约 3.84 MB 数据随工作区脚本一起下发。

## 决定

- 聊天正文、工作区预览和独立编辑器共用 `LazyMarkdownRuntime`，将解析器保留为单一动态 chunk，避免同一模块图同时存在静态和动态入口。
- VS Code 图标映射、Iconify 渲染和图标集均保留。完整图标 JSON 作为独立 JS 资源输出，目录树首次挂载时加载并注册；不在 renderer 初始 chunk 中内嵌这份数据。
- 用 Rolldown `codeSplitting.groups` 将初始依赖按 React、KaTeX、TipTap/ProseMirror、AI SDK 四组拆分，并保持动态入口的依赖按需加载。

## 修复

- `LazyMarkdownRuntime` 统一聊天、工作区预览和独立编辑器的 Markdown 入口，同一解析器只保留一个动态 chunk。
- 目录树改为首次挂载时加载 `assets/vscode-icons.js` 并注册图标集；dev 中间件与构建产物共用同一相对路径，图标数据不进入 renderer 模块图。
- `apps/desktop/vite.config.ts` 增加 `rendererChunkGroups`，按 React、KaTeX、TipTap/ProseMirror、AI SDK 拆分 vendor chunk。
- 懒加载改变测试时序：UI 测试的异步等待窗口调到 5 秒，单测超时调到 15 秒；`TextResponse` 与回复弹层测试改为等待运行时解析完成。
- Vite 配置改为带 `.ts` 扩展的 import，避免未来 native config loader 失效。

## 曾考虑的替代方案

- **删除或替换 VS Code 图标：** 会改变用户明确希望保留的目录树外观，舍弃。
- **把图标 JSON 保持在 renderer 模块内并提高 chunk 警告阈值：** 只隐藏警告，不降低工作区脚本体积，舍弃。
- **让 Markdown 解析器在各消费者分别静态/动态导入：** 会重复解析器或造成动态导入失效警告，舍弃。
- **继续用单一主入口并忽略 500 KB 提示：** 会保留 1 MB 级首屏脚本，舍弃；按依赖组拆分可维持现有业务模块边界。

## 后果与防回退

- 工作区首次打开时会额外请求一次完整图标资源；浏览器缓存后复用。图标集仍完整离线随包提供，不依赖网络。
- 构建产物的脚本按依赖组分散到多个小 chunk；新增依赖时仍需检查是否产生超过 500 KB 的单体模块或不必要的初始依赖。
- 目录树不得移除 VS Code 图标映射或将整套图标 JSON 静态打入 renderer JavaScript。
- Markdown 解析器需要新增消费者时继续复用 `LazyMarkdownRuntime`，不另建静态解析器入口。

## 验证

- `pnpm --filter @answra/desktop build:answer`：无超过 500 KB 的 chunk、无动态导入警告；入口 `index-*.js` 107.40 kB；`vendor-react` 220.45 kB、`vendor-ai` 247.13 kB、`vendor-katex` 260.23 kB、`vendor-editor` 279.47 kB、`MarkdownRuntime` 383.58 kB；工作区面板 108.16 kB。
- `pnpm --filter @answra/desktop build`（full）：入口 125.89 kB，最大 chunk 383.58 kB，构建无警告。
- `pnpm typecheck`、`pnpm --filter @answra/desktop test`（282 项）、`pnpm --filter @answra/ui test`（204 项）、`pnpm lint`、`pnpm architecture:check` 与 `pnpm verify` 通过。
- `vscode-icons.js` 仍为 3,840.28 kB 独立资源，不进入任何 JS chunk；首次打开工作区目录树时一次加载，浏览器缓存复用。
