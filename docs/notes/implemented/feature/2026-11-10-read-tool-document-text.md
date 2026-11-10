# Note：Read 工具读取 PDF / Word 文档文本

状态：已实施

## 问题

`Read` 目前只支持 UTF-8/UTF-16 纯文本；PDF、`.doc`、`.docx` 会被二进制预检拒绝。用户需要在同一个 Read 入口读取简历、报告等文档，而不是再增加一个模型工具或依赖本机 Office/Poppler。

本次把三种文档的**纯文本抽取**接入现有 `Read`，保持路径、`offset`/`limit`、token 预算和 `file_unchanged` 行为一致；不实现渲染、版式还原、OCR 或文档编辑。

## 涉及范围

- `apps/agent/src/core/tool/builtin/read.ts`：格式分派、工具描述、60 秒超时。
- `apps/agent/src/core/tool/builtin/readOutput.ts`：`ReadTextOutput.document` 元数据、PDF/Word 提示、token 裁剪时保留元数据。
- `apps/agent/src/core/tool/builtin/documents/contracts.ts`：文档格式与元数据契约。
- `apps/agent/src/core/tool/builtin/documents/documentFormat.ts`：按扩展名识别 PDF/DOC/DOCX。
- `apps/agent/src/core/tool/builtin/documents/pdfText.ts`：pdfjs 逐页抽取文本。
- `apps/agent/src/core/tool/builtin/documents/wordText.ts`：word-extractor 抽取 Word 正文。
- `apps/agent/src/core/tool/builtin/documents/documentText.ts`：20 MiB 上限、格式分派、错误归一化。
- `apps/agent/src/types/word-extractor.d.ts`、`apps/agent/src/types/pdfjs-dist-worker.d.ts`：CJS 依赖与 pdfjs worker 子路径的类型声明。
- `apps/agent/package.json`、`pnpm-lock.yaml`：新增 `pdfjs-dist@4.10.38`、`word-extractor@1.0.4`。
- 相关 Note：`2026-11-09-read-tool-text-quality.md`、`2026-10-26-agent-tool-registry.md`。

## 影响表面

- `Read` 现在接受 `.pdf`、`.doc`、`.docx`；工具描述明确说明 PDF 按页返回、Word 只取正文。
- PDF 输出带 `--- 第 N 页 ---` 标记；没有文本层的页显示 `[本页无可提取文本]`，并向模型提示空页数量。整份 PDF 都没有文本时返回 `invalid-input`，不伪装成空文件。
- Word 只返回正文；页眉、页脚、批注、图片不进入 `Read` 结果，并通过 system-reminder 明确告知模型。
- 文档输入上限 20 MiB；超过时返回 `output-too-large`，不做静默截断。文本文件原有上限不变。
- 文档文本仍受 25k token 预算约束；超限时继续复用部分视图和下一 `offset` 提示。`offset`/`limit` 作用于抽取后的行。
- 文档读取同样进入会话级 `readFileState`；文件未变化时返回 `file_unchanged`。
- 未修改 UI、IPC、worker 协议、持久化表面或工具授权清单；没有新增模型工具。

## 决定

- 使用 `pdfjs-dist@4.10.38` 的 `legacy/build` 做纯文本抽取，不渲染页面、不依赖系统字体或外部二进制。
- 在 Node/Electron 的 CJS bundle 中，pdfjs 的 fake worker 会按相对路径加载 `pdf.worker.mjs`，打包后会丢失。因此在 `getDocument` 前静态导入 `pdfjs-dist/legacy/build/pdf.worker.mjs` 并挂到 `globalThis.pdfjsWorker`，让 fake worker 走主线程 handler。不能删除这段预加载。
- 传给 pdfjs 的数据必须是普通 `Uint8Array`，不能直接传 Node `Buffer`；当前用 `new Uint8Array(bytes.buffer, byteOffset, byteLength)` 生成视图，避免额外复制。
- 使用 `word-extractor@1.0.4` 同时处理 OLE `.doc` 和 OpenXML `.docx`，只读取 `getBody()`。它的 CJS 默认导出通过静态 import 打包，不能用 `createRequire(import.meta.url)`，否则 CJS worker 中 `import.meta.url` 为空或指向错误路径。
- 不引入 `mammoth`：它只支持 `.docx`，会让 `.doc` 继续不可读。
- 文档大小上限 20 MiB、工具超时 60 秒；这是文本抽取，不是完整解析器，避免异常文档长期占用 worker。
- 本轮按用户要求不新增自动化测试，也不把新测试加入门禁；以本地手动验证作为本轮证据。后续若要把文档读取纳入发布门禁，应补 PDF/Word/损坏输入/大小上限的回归测试。

## 曾考虑的替代方案

- **`@ariadng/office`：** 舍弃。它能读写 `.docx` 并保留未修改内容，但不支持旧版 `.doc`；且 `0.3.0` 在 Electron 29.4.6 / Node 20.9 上打开和保存都会因 `CompressionStream('deflate-raw')` 失败。它是未来 Office 编辑工具的候选，不是当前只读文本抽取的依赖。
- **Poppler / ZCode 的 PDF 路线：** 舍弃。ZCode 的 PDF 能力依赖外部 Poppler 子进程或模型原生 PDF 输入；Answra 需要单文件 Agent worker 和可打包依赖，引入二进制会扩大安装包和平台适配面。
- **officecli / 外部 Office CLI：** 舍弃。opencode 本身不内置 officecli，只是通过外部 skill 调用二进制；这与 Agent 进程内工具和跨平台打包目标不一致。
- **`mammoth`：** 舍弃。只支持 `.docx`，无法覆盖用户明确要求的 `.doc`。
- **`pdf-parse`：** 舍弃。它内部仍依赖 pdfjs，额外包一层没有减少资源边界，反而增加版本和错误映射的不确定性。
- **新增独立 `Document` 工具：** 舍弃。用户要的是在现有 Read 中读文档；新工具会带来额外的授权清单、提示词和模型选择成本，且 `offset`/`limit`、token 预算、文件状态都要重复实现。
- **让模型直接接收 PDF 原生输入：** 舍弃。当前 Agent 工具链是本地文本读取，原生 PDF 输入会把解析和计费转移到模型侧，且 `.doc`/`.docx` 仍需本地解析。

## 后果与防回退

- 正面后果：模型可以在同一个 `Read` 中读取 PDF、`.doc`、`.docx`，并获得页数、空页、Word 正文范围等明确事实；错误输入、加密 PDF、损坏 Word、超大文档都有稳定错误码。
- 代价：desktop 的 agent worker 打包体积增加；本机实测 `worker.cjs` 约 3.48 MB。pdfjs 在 Electron 29 / Node 20.9 首次加载会打印 `process.getBuiltinModule` 和 DOM polyfill 警告，但文本抽取正常，当前接受为已知噪音。
- 能力边界：不提供 OCR、版面/表格还原、页眉页脚、批注、图片、公式或 PDF 渲染；扫描件只能得到“无文本”提示。
- 防回退：
  - 不得移除 pdfjs worker 预加载，否则 CJS 打包后会报找不到 `pdf.worker.mjs`。
  - 不得把 Node `Buffer` 直接传给 pdfjs；必须先转成普通 `Uint8Array` 视图。
  - 不得用 `createRequire(import.meta.url)` 加载 `word-extractor`；必须保持可被打包的静态 import。
  - `apps/agent/src/index.ts` 必须保留两个 ambient 声明文件的 `/// <reference path>`；desktop 的 `tsconfig.main.json` 只 include `src/main`，删除后会在 `@answra/desktop typecheck` 中重新出现 TS7016。
  - 不得把“整份 PDF 无文本”降级为空文件或空字符串，必须返回明确错误。
  - 不得静默截断超过 20 MiB 的文档；必须返回 `output-too-large`。
  - 不得让文档读取绕过 `readFileState`，否则重复读取会浪费上下文。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/desktop typecheck`：通过；确认 desktop 通过 `@answra/agent` 入口加载 ambient 声明。
- `pnpm --filter @answra/desktop build:electron -- --profile=full`：通过；`worker.cjs` 打包后约 3,484,114 字节。
- `pnpm exec biome check`（本次改动文件）：通过。
- 本地手动验证（Electron 29.4.6 / Node 20.9.0，以及 Node 24.16.0）：
  - `dummy.pdf`：输出 `--- 第 1 页 ---` 和 `Dummy PDF file`，`pageCount=1`、`emptyPageCount=0`。
  - `test01.docx`、`test01.doc`：均输出正文，包含中文/emoji/Unicode 字符；`.doc` 与 `.docx` 走同一个 `word-extractor` 分支。
  - 损坏 PDF：`invalid-input`，`PDF 文件损坏或格式无效。`
  - 损坏 DOCX：`invalid-input`，`Word 文档解析失败：文件可能损坏、加密或格式不受支持。`
  - 21 MiB PDF：`output-too-large`，提示超过 20 MiB 上限。
  - 不存在的 PDF：`invalid-input`，返回工作区根目录和文件不存在提示。
  - 通过真实 `executeRead` 调用验证 `dummy.pdf`、`test01.docx`、`test01.doc` 均返回 `type: "text"`，并带上 `document.format` / `document.pageCount`。
- 本轮未新增自动化测试，符合用户“不把测试放进门禁”的要求；上述手动验证未写入测试套件。
