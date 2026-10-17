# Note：禁止在 src 中自建本地监听

状态：已实施

## 问题

产品后续能力（实时语音、AI 读写文档、回复注入、浏览器填表单）会不断引出"要不要起个本地服务"的冲动：语音要推流、扩展要连应用、多个界面要共享会话。一旦随手 `createServer().listen()`，代价是这个产品形态难以承受的：

- 本地端口会被**同机任意进程与浏览器页面**探测到；隐身/低调是这个产品的核心定位，一个扫描就能暴露"这应用正在跑"。
- 需要额外的 token、来源校验、CSRF/CORS 处理，任何一处漏掉就是本地越权面。
- 端口冲突、Windows 防火墙弹窗、打包与签名复杂度、企业环境安全软件告警。

当前仓库并没有这个需求：进程间通信已经有更合适的形态——Electron `utilityProcess` 消息端口（main ↔ agent）、`stdio` 管道（`rimeBridge.ts` spawn `answra-rime-host`）、自定义 scheme（`fileProtocol`）。但没有任何约束阻止下一个人顺手加一个 HTTP 服务。

## 涉及范围

- 代码/模块：`scripts/architecture/architecture-check.mjs`（新增 `forbidLocalListeners` 规则）。
- UI/进程/协议/持久化表面：无行为变化；这是对新增代码的约束。
- 相关 Note：[Agent 组装点收归自身并抽象宿主传输](2026-10-17-agent-host-composition-and-transport.md)、[面试语音协议 AVP](../../proposed/architecture/2026-10-16-answra-voice-protocol-avp-v1.md)（客户端 WSS 出站，不是本地服务）、[拒绝：本地 app service 与 agent 边界](../../rejected/architecture/2026-10-11-local-app-service-and-agent-boundary.md)。

## 决定

- `src/` 下（测试文件除外）不得出现 `createServer(` 或 `.listen(`；架构守护在 `pnpm architecture:check` 中强制，违规即失败并提示"如需本地服务先补架构 Note"。
- 进程间通信的既有形态按场景选用：main ↔ agent 用 `utilityProcess` 消息端口；本地辅助二进制用 `stdio` 管道；把本地文件给渲染层用自定义 scheme；渲染层 ↔ 平台能力走 preload/`DesktopBridge`。
- 远端服务不受此约束：语音识别、模型调用、未来的 AnswraSite 网关都是**出站** WSS/HTTPS 客户端。产品侧的"服务"在远端，不在本仓。

引入本地监听的触发条件（满足其一才重新评审）：出现**第二个本地客户端**（手机、Web 面板、另一个应用要连同一会话）、需要把能力**托管/开放**给外部（MCP server 角色、插件体系、开放 API）、或**无窗口常驻**且必须被外部唤醒。即便触发，也应优先评估本地 socket + 显式握手，而非直接开 HTTP。

## 模块边界

- `scripts/architecture/architecture-check.mjs`：新增规则只扫描非测试 `src`，作用于 `packages/*` 与 `apps/*`；测试内的本地 server（如 `apps/agent/test/conversation/runtime.test.ts` 的假 OpenAI-compatible 端点）仍然是允许且必要的。
- 其余边界不变：`apps/agent` 无 Electron/React 依赖、平台能力留在 desktop、渲染层走 `DesktopBridge`。

## 曾考虑的替代方案

- **只写进文档不设约束：** 与本次的触发原因相同——约束不落到 CI 上就等于没有；`pnpm verify` 已经跑架构守护，加规则的边际成本几乎为零。
- **禁止 import `node:http` / `node:net`：** 误伤面更大（出站请求、URL 解析等），且不直接对应"开监听"这个行为；直接匹配 `createServer(`/`.listen(` 更准确。
- **加白名单目录允许 desktop 起服务：** 目前没有这个需求，留白名单等于预留缺口。
- **把规则做成告警而非错误：** 告警会在日常输出里被忽略；这条约束的代价足够大，按错误处理。

## 后果与防回退

- 需要本地服务时，必须先补一份架构 Note 说明触发条件、通信形态与安全边界，再改守护规则；不允许先合并服务、后补理由。
- 新规则不得放宽成白名单目录；测试文件继续豁免（守护脚本本就跳过 `*.test.ts`）。
- 引入任何监听前必须回答：谁能连、如何鉴权、如何避免被同机进程与页面发现。

## 验证

- 反向验证：向 `packages/shared/src/` 临时放入 `createServer().listen(0)`，`pnpm architecture:check` 立即报 "禁止在 src 中开启本地监听"（探针文件已删除）。
- 现有代码库零命中：`apps/*/src` 与 `packages/*/src` 均无 `createServer(`/`.listen(`，规则加入后 `pnpm architecture:check` 与 `pnpm verify` 通过。
- 未做：Remote/容器等非本机场景的监听需求（当前不存在）。
