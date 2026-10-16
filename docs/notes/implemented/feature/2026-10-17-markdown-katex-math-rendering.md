# Note：Markdown 公式渲染（KaTeX）

状态：已实施

## 问题

模型输出与工作区笔记里经常出现 LaTeX 公式（如 `$v=\frac{10}{3}$`、`$$v\approx 3.33$$`），但两处 markdown 渲染器都没有数学插件：AI 正文（`TextResponse`）只有 remark-gfm，工作区预览（`MarkdownStaticPreview`）只有 remark-gfm + rehype-raw + rehype-sanitize，`$...$`、`\frac`、`\Rightarrow` 全部按原文显示，用户看到反斜杠乱码而不是公式。回复条跑马灯（`ReplyActivityTicker`）只渲染纯文本，同样显示不出公式。

## 涉及范围

- 代码/模块：`packages/ui/src/components/chat/TextResponse.tsx`、`packages/ui/src/components/panels/workspace/MarkdownEditorPane.tsx`、`packages/ui/src/components/panels/ReplyActivityTicker.tsx`、`packages/ui/src/components/panels/ReplyBar.css`、`packages/ui/src/styles.css`、`packages/ui/package.json`。
- UI/进程/协议/持久化表面：AI 正文与工作区笔记预览新增公式能力、回复条跑马灯单行布局、KaTeX 字体静态资源随包打包。
- 相关 Note：[回复 Markdown 流式渲染](2026-10-12-reply-markdown-streaming.md)、[工作区 Markdown 编辑器](2026-10-12-workspace-markdown-editor.md)、[工作区 Markdown 默认预览](2026-10-13-workspace-markdown-default-preview.md)。

## 决定

引入 `remark-math` + `rehype-katex` + `katex`（加入 `@answra/ui` 运行时依赖，版本组合与 WeCode 参考实现一致），保持现有 react-markdown 管线不变：

- `TextResponse`：`remarkPlugins=[remarkGfm, remarkMath]`，`rehypePlugins=[[rehypeKatex, { strict: false }]]`。
- `MarkdownStaticPreview`：`remark=[gfm, math]`；rehype 顺序固定为 `[raw, sanitize, katex]`，KaTeX 必须排在 sanitize 之后。默认白名单会剥掉 `span` 的 class/style 以及 MathML/svg 标签，但保留 `code` 上的 `^language-` className，因此 remark-math 生成的 `language-math` 能存活；于是先由 sanitize 净化用户内嵌 HTML，再由 KaTeX 依据纯文本生成可信公式 HTML。
- `packages/ui/src/styles.css` 聚合入口 `@import "katex/dist/katex.min.css"`，字体随包离线打包，不引用 CDN。
- 跑马灯不接整段 markdown，而是在 `ReplyActivityTicker` 内做单行内联公式渲染：正则切分 `$...$` / `$$...$$`，只把公式片段交给 `katex.renderToString({ throwOnError: false, strict: false })`，其余保持纯文本，以保住 nowrap 单行轨道；`.reply-activity-viewport` / `.reply-activity-track` 由固定 `height: 22px` 改为 `min-height: 22px`，让行高随公式自适应；`.reply-activity-item .katex { font-size: 1em }` 压到正文级字号。

## 影响表面

- AI 正文（`TextResponse`，被 ChatPanel 与回复条详细面板共用）与工作区笔记预览同时支持行内 `$...$` 与块级 `$$...$$` 公式。
- 跑马灯里的公式统一按行内模式渲染（不换行）；未闭合的 `$` 在流式期间保持原文，闭合后变为公式。
- 单行 `$$v\approx 3.33$$` 会被 remark-math 当作行内公式（不产生 `.katex-display`、不换行）；块级公式需要独占段落的多行写法 `$$\n...\n$$`。
- 非法 LaTeX 不会抛错或中断流式渲染，降级为标红的 `.katex-error` 并显示原文。
- `@answra/ui` 新增依赖 `katex`、`rehype-katex`、`remark-math`；发布包需随附 KaTeX 字体文件才能离线显示。

## 曾考虑的替代方案

- **整体改用 Streamdown（WeCode 做法）：** 它自带 `@streamdown/math` 与流式容错，但以 Tailwind/shadcn token 为基础，而 Answra 用 `--ink/--field` 自有 token 且未引入 Tailwind，替换等于重写正文组件与全部样式，风险远大于收益；因此只借用它的依赖组合，保留 react-markdown。
- **KaTeX 排在 sanitize 之前：** 公式输出会先被白名单剥掉 class/style 与 MathML，渲染残缺或退回原文；因此固定 `[raw, sanitize, katex]`。
- **放宽 sanitize 白名单以容纳 KaTeX 输出：** 等于给用户内嵌 HTML 打开 style 与 MathML 通道，扩大注入面；因此不改白名单，改为让 KaTeX 在净化之后生成。
- **跑马灯复用 `TextResponse` 渲染整段 markdown：** 会把 `p`、列表、代码块带进单行 nowrap 轨道，破坏跑马灯布局并放大高度抖动；因此只在跑马灯内联渲染公式。
- **跑马灯保留固定 22px 高度：** 行内 `\frac` 这类高公式会被 `overflow-y: hidden` 裁掉；因此改为 `min-height` 自适应。

## 后果与防回退

- rehype 插件顺序成为约束契约：工作区预览必须是 `raw → sanitize → katex`。调整顺序不会报错，只会静默降级成原文，排障时优先怀疑此处。
- 跑马灯只做公式内联渲染，禁止在其中引入块级 markdown（列表/表格/代码块/图片），否则单行轨道布局会碎掉。
- KaTeX 字体必须随包离线可用，不得改为 CDN 引用，否则离线/断网时公式错位。
- 直接调用 `katex.renderToString` 的输入只允许来自模型输出或笔记文本，不得先拼接用户 HTML 再注入。

## 验证

- UI 测试：`packages/ui/test/markdownEditorPane.test.tsx` 断言预览出现 `.katex` 与 `.katex-display`、原文 `$` 消失且普通 markdown 元素仍在；`packages/ui/test/ReplyBarWindowApp.test.tsx` 断言跑马灯活动文本里的 `$v=2$` 渲染为 `.katex`（原文不再出现）、详细面板正文出现 `.katex` 与 `.katex-display`。
- 运行 `pnpm notes:check`、`pnpm verify`。
