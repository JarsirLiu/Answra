# Note：Coding 联网搜索与网页抓取工具（免 API Key）

状态：已实施

## 问题

CLI coding 领域只授权 `workspace.read`、`workspace.grep`、`workspace.edit`、`workspace.run-command` 四个工作区工具。模型遇到「最新版本是什么」「某个库的官方文档怎么写」这类问题时只能凭记忆回答，无法查证；用户也不希望为此再配一个搜索服务的 API Key。

用户明确要求：优先复用开放、免密钥的搜索能力；没有就算了。同时提出更远期的想法——让 AI 操作用户已登录的浏览器帮忙填表——但那属于另一类平台能力，不并入本次。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/tool/builtin/web/`（新增）：`http.ts`、`html.ts`、`tool.ts`。
  - `apps/agent/src/core/tool/{ids,names,index}.ts`：新增 `web.search` / `web.fetch` 静态 ID、`WebSearch` / `WebFetch` wire name 与公开工厂导出。
  - `apps/agent/src/core/tool/builtin/index.ts`：注册两个网络工具。
  - `apps/agent/src/coding/policy.ts`、`apps/agent/src/bots/coding/policy.ts`：两份 coding policy 同时授权两个工具，并补充提示词。
  - `packages/ui/src/tool-presentation/`：新增 `WebSearch` / `WebFetch` canonical name、别名与 presenter；`ToolPresentation` 增加搜索名词 `searchTerm`。
  - `packages/ui/src/components/tool-call/`：新增 `WebSearch` 搜索框 renderer 与 `ToolCallCard` 的 `search` variant。
  - `apps/cli/src/presentation/toolLabels.ts`、`toolSummary.ts`：补齐 CLI 标签与 `query:` 摘要。
- 测试：
  - `apps/agent/test/core/tool/web.test.ts`（新增）
  - `apps/agent/test/core/tool/builtinTools.test.ts`（扩展注册清单断言）
  - `apps/agent/test/coding/agent.test.ts`（扩展 coding 工具集断言）
  - `packages/ui/test/toolPresentation.test.ts`、`apps/cli/test/presentation/toolLine.test.ts`（扩展）
- UI/进程/协议/持久化表面：
  - 不新增 IPC 频道、不改 worker 线协议、不改 `packages/shared/src/schema/`；复用既有 `tool-execution-started` / `tool-execution-finished` 事件。
  - 不新增环境变量、不读写 `config.json`、不访问 keychain、不落盘。
  - 不引入新依赖：HTML 文本化是约 100 行的纯函数，不引入 cheerio/htmlparser2。
- 相关 Note：
  - [2026-11-09 Agent 工具系统基础](../architecture/2026-11-09-agent-tool-system-foundation.md)
  - [2026-11-10 工作区 Edit 工具](2026-11-10-workspace-edit-tool.md)
  - [2026-10-20 产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

### 1. 两个工具，职责分开

- `WebSearch`（`web.search`）：输入 `query`（必填，≤200 字符）与可选 `limit`（1–10，默认 5），请求 Bing 结果页，返回带编号的标题、链接与摘要。
- `WebFetch`（`web.fetch`）：输入 `url`（必填）与可选 `max_chars`（1000–50000，默认 20000），抓取公开网页并提取纯文本。
- 两者都是 `readOnly: true`、`destructive: false`、`concurrentSafe: true`、`sideEffectScope: "network"`，`exposeOutput: true`。超时 25s，结果按字符截断，不把原始 HTML 塞进模型上下文。
- 输出预算同时声明字符上限与字节上限（单字符按 4 字节预留 + 包装余量）。执行器按 UTF-8 字节先判 `output-too-large`，只按字符定预算会让长中文页面直接失败而不是截断；`skill.load` 已有同样处理，这里沿用。
- 只在 coding 领域授权；其他领域（面试、general chat）保持原有工具集，不受影响。

### 2. 为什么是 Bing 结果页

在用户机器上实测（2026-11-28）：

| 端点 | 结果 |
| --- | --- |
| `https://www.bing.com/search?q=...` | HTTP 200，稳定返回 `li.b_algo` 结果块 |
| `https://www.bing.com/search?...&format=rss` | HTTP 200，但响应版权声明明确限制「非个人非商业 RSS 聚合器之外的使用」，不采用 |
| DuckDuckGo HTML / lite、Wikipedia API、Google | 本机请求超时 |
| Tavily 免密钥模式（`X-Tavily-Access-Mode: keyless`） | 返回 `daily_cap_reached`，有日额度上限 |

对照 `D:\apps\opencode`：它的 `websearch` 没有本地公共搜索抓取器，所谓「免密」是 Tavily / TinyFish 等厂商授予的 keyless 模式；Exa / Firecrawl / Parallel 也只是未带 Key 时直连其 MCP。这类额度不受我们控制，因此不照搬。Bing 结果页是当前机器上唯一实测可用且无需任何凭据的公开搜索入口。

搜索端点是 Agent 内的固定常量，不进配置、不进环境变量；`createWebTools({ searchEndpoint, fetch })` 只用于测试注入。

### 3. 抓取的安全边界

`WebFetch` 不是任意 URL 读取器：

- 只接受 `http:` / `https:`，拒绝 URL 内嵌用户名密码。
- 拒绝 `localhost`、`.localhost`、所有 IPv6 字面量，以及 0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0.0/16、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4。
- `fetch` 使用 `redirect: "manual"`，每个重定向目标重新过同一套检查，最多 5 跳。
- 响应体最多读 2 MiB，按流分块累计；非文本 `Content-Type` 直接失败。
- 只做文本投影：去掉 `script` / `style` / `noscript` / `iframe` / `svg` / `head` 与注释，解码常见 HTML 实体，按块级标签断行；不执行页面脚本，不携带 Cookie，不使用用户浏览器登录态。

DNS 重绑定不在本工具防御范围内：地址检查只看字面量，不解析域名。接受这一残余风险，因为工具是只读的，且响应不回写任何本地位置。

部分站点有反爬策略：实测抓取 `baike.baidu.com` 返回 HTTP 403，`example.com`、`nodejs.org`、`bing.com` 正常。403 会作为 `handler-failed` 返回给模型，由模型换来源或改用搜索摘要，不做 UA 军备竞赛。

### 4. 错误语义

工具内部用 `WebRequestError` 分类，再映射到既有 `ToolFailureCode`：

- 非法/内网 URL → `invalid-input`；
- 超时 → `timeout`；外部取消 → `aborted`；
- HTTP 非 2xx、不支持的内容类型、连接失败 → `handler-failed`。

业务失败返回给模型作工具结果文本，不抛成 AI SDK 执行异常；无搜索结果时明确返回「未找到」，不编造链接。

### 5. 搜索在界面上的呈现

对照 `D:\apps\claude-code` 的 `WebSearchTool/UI.tsx`：它把工具行渲染成 `Web Search("query")`，运行中显示 `Searching: query`，结束后显示 `Did N searches in Xms`。参考该分法，本仓库把「搜索」与「检索代码」在展示层分开：

- 桌面端 `WebSearch` 使用只读搜索框外观：整行是一条带放大镜、关键词与结果数的字段（`ToolCallCard` 的 `search` variant），展开后按条列出标题、链接与摘要。URL 只作为文本展示，不渲染 `<a>`，避免在 Electron 渲染进程里直接导航；点击行为仍是展开/收起。
- 不把搜索框做成可编辑输入：工具调用由 Agent 发起，可编辑框会暗示「输入即可重新搜索」，而重跑搜索需要新的会话动作和 IPC，超出本 Note 范围。
- TUI 沿用 `Label(target)` 格式，但把名词从 Grep 的 `pattern` 改为 `query`（`ToolPresentation.searchTerm`）：`Search(query: "node.js")`；结果行仍是 `N results`。Grep 的 `pattern:` 文案不变，避免为对齐参考实现而改动既有工具行。
- 解析失败时（Bing 改版或输出被截断）回退为原样文本面板，不猜结构、不生成假链接。

## 影响表面

- 用户行为：CLI coding 在需要最新公开信息时可以自己搜索并抓取正文；不需要配任何 Key。其他领域行为不变。
- 工具集：`registry.list()` 多两个条目；只有授权它们的 Agent 才会把工具 schema 发给模型。模型 step 上限仍是原来的 `createToolStepLimit()`。
- UI/CLI：`WebSearch` 在桌面端渲染为搜索框并展开结果列表，在 TUI 渲染为 `Search(query: …)`；`WebFetch` 保持普通工具行。页面正文不进入摘要行。
- 网络：Agent 进程首次具备出站 HTTP 能力，仅由这两个工具触发；不经过 desktop，不做反向 RPC。

## 模块边界

- `builtin/web/http.ts`：只做 URL 判定、重定向与有界读取；不知道 Bing，也不知道模型。
- `builtin/web/html.ts`：纯文本投影与 Bing 结果块解析；不联网。
- `builtin/web/tool.ts`：工具契约与输入校验；不发请求之外的策略判断。
- `packages/ui` / `apps/cli`：只做展示投影，不解析 HTML、不判断网络错误。

## 曾考虑的替代方案

- **照搬 opencode 的 Tavily / TinyFish keyless 模式：** 舍弃。本机实测 Tavily 免密额度已用完，额度由第三方控制，无法保证可用。
- **Bing RSS（`format=rss`）：** 舍弃。XML 结构比 HTML 好解析，但响应自带版权声明限制复用，不适合产品内长期调用。
- **DuckDuckGo HTML / lite、Wikipedia、Google：** 舍弃。本机全部超时；不把核心能力押在不通的端点上。
- **做成 desktop 侧平台工具，用键鼠/浏览器自动化代查：** 舍弃。与「Agent 工具在 Agent 进程执行、不通过反向 RPC 让 desktop 代执行」冲突，且需要用户已登录浏览器，权限面过大。
- **引入 cheerio / htmlparser2：** 舍弃。只解析固定结构的结果块与做文本化，新增依赖的收益不足以覆盖 bundle 与供应链成本。
- **把搜索端点做成配置项 / 环境变量：** 舍弃。用户要求零配置；固定端点也让安全边界可审计。

## 后果与防回退

- `builtinTools.test.ts` 锁住注册清单顺序，新增工具必须显式更新断言；授权列表为空的测试锁住「注册 ≠ 暴露」。
- `test/coding/agent.test.ts` 锁住 coding 实际发出的模型工具集，注册了新工具却漏授权会在这一层失败。
- `web.test.ts` 覆盖 Bing 结果解析、实体解码、脚本剔除、`max_chars` 截断、长中文正文仍走截断而非 `output-too-large`、内网/IPv6/file/凭据 URL 阻断、超长 URL 拒绝、重定向二次校验、HTTP 失败、超时与取消的码映射。
- 两份 coding policy 必须同步：只改其中一份会让 CLI 与桌面 coding 的工具集分叉。
- 不在其他领域 policy 中加入 `web.*`：面试 intake 的 Note 明确要求「不 clone、不联网抓取」。
- 用户浏览器自动化（登录态、填表）明确不在本 Note 范围；需要另立产品方向与架构 Note，走扩展 + Native Messaging 或 desktop 独立能力流，不得伪装成普通 Agent 工具。

## 验证

- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/cli typecheck` 通过。
- `apps/agent`：`web.test.ts` + `builtinTools.test.ts` 共 25 个测试通过；`coding/agent.test.ts` 的工具集断言同步更新后，全包 855 个测试通过。
- `packages/ui`：`toolPresentation.test.ts` 18 个测试通过，`toolCallRenderers.test.tsx` 覆盖搜索框、空结果与原样回退，全包 403 个通过；`apps/cli`：`toolLine.test.ts` 4 个通过，全包 414 个通过。
- 实机连通性：在用户机器上直接 `fetch` Bing 结果页返回 200，结果块结构稳定；Tavily 免密模式返回 `daily_cap_reached`，DuckDuckGo / Wikipedia / Google 超时。
- 端到端冒烟：用真实 `createWebTools()` 调 `WebSearch` 得到 3 条带链接与摘要的结果；随后 `WebFetch` 抓取其中链接，对反爬站点正确返回 403 失败，`example.com` / `nodejs.org` / `bing.com` 返回可读正文并按 `max_chars` 截断。
