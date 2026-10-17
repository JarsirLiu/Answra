# Note：开发态 OAuth 环回回调的单一例外

状态：已实施

## 问题

[禁止在 src 中自建本地监听](2026-10-17-local-listener-forbidden.md) 把"`src/` 里不得 `createServer(`/`.listen(`"设为硬约束，理由是监听端口会被同机进程与浏览器页面探测到，与产品的隐身定位冲突。但账号登录引入了一个真实需求：OAuth 回跳。

打包版用自定义 scheme（`answra://auth/callback`）没问题；开发态则不行——开发态的协议注册要把 `process.execPath` 与**入口脚本路径**一起交给系统，热重载、多实例、不同启动方式下回跳经常丢失，`pnpm dev` 里根本走不通登录链路。于是出现一个"规则说不能、但确实需要"的缺口。缺口的危险在于：一旦破例写成注释，下一个人就会照着抄。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/auth/loopbackCallback.ts`（唯一例外实现）、`apps/desktop/src/main/auth/callbackChannel.ts`（通道端口与两种实现）、`scripts/architecture/architecture-check.mjs`（`forbidLocalListeners` 的白名单 + 断言）。
- UI/进程/协议/持久化表面：无新增 IPC 或持久化；打包产物**不含**任何监听（`app.isPackaged` 直接抛错）。
- 相关 Note：[禁止在 src 中自建本地监听](2026-10-17-local-listener-forbidden.md)（被本 Note 收窄为白名单式）、[桌面端账号登录与凭据（Phase 0）](../feature/2026-10-17-desktop-account-login-and-credentials.md)。

## 决定

- 例外**只有一个文件**：`apps/desktop/src/main/auth/loopbackCallback.ts`。它只绑 `127.0.0.1`（`LOOPBACK_HOST` 常量）、端口取 0（系统分配，避免冲突），路径固定 `/auth/callback`，每次登录起一个、回跳或登出即 `close()`。
- 打包版直接拒绝：`app.isPackaged` 为真时 `startLoopbackCallback` 立即抛错；`main/index.ts` 只在非打包分支选 `loopbackCallbackChannel`。打包产物里这段代码存在（会被 bundle），但**运行时不可达**：打包分支永远选中深链通道，即使被误选也会在 `startLoopbackCallback` 直接抛错。
- 守护脚本把禁令改为**白名单 + 断言**：命中 `createServer(`/`.listen(` 的文件必须在 `LOCAL_LISTENER_EXCEPTIONS` 里；白名单条目还要逐条断言（"只绑定 127.0.0.1"、`app.isPackaged` 在场），断言消失同样失败。规则从"绝对禁止"变成"禁止 + 一处可审计的例外"。
- 例外只服务**回调接收**：它与登录编排解耦，`AuthService` 只依赖 `AuthCallbackChannel` 端口，不感知深链还是环回。

## 模块边界

- `main/auth/loopbackCallback.ts`：唯一允许 `listen` 的 `src` 文件；只做"收一个回调 URL → 交给通道回调"。
- `main/auth/callbackChannel.ts`：端口与两种实现（深链 / 环回）的组装点，是"平台形态"知识的唯一落点。
- `main/auth/authService.ts`：Electron 无关的编排逻辑（PKCE、交换、刷新、状态推送），可注入 fetch / 存储 / 通道，测试不加载 Electron。
- `packages/shared`：只放 `AuthChannels`/`AuthStatus` 契约；`packages/ui` 只消费 `AuthStatus`；agent 完全不参与。
- `scripts/architecture/architecture-check.mjs`：规则与白名单同处一文件，白名单条目必须自带断言，便于 review 时一眼看出"这条例外凭什么在"。

## 曾考虑的替代方案

- **开发态也只用深链、不留例外：** 规则最干净，但开发循环要反复手动注册协议、且热重载后回跳丢失，等于把登录链路的日常验证成本抬高到不可接受；舍弃，改为受控例外。
- **打包版也开环回（"用户可能没装协议处理器"）：** 直接违背隐身定位，且把监听带进发行物；舍弃。
- **允许 `localhost` 作为绑定主机：** 解析结果可能指向非环回地址（hosts/解析器差异），安全断言写不干净；只允许字面量 `127.0.0.1`。
- **只写注释说明例外、不加断言：** 例外会悄悄扩散（多一个文件、少一个 `isPackaged` 判断都不会被发现）；改为脚本断言，漏掉即 CI 失败。
- **把环回监听放进 `packages/*` 复用：** 目前只有 desktop 一个消费者，且监听属于平台能力；出现第二个消费者时再评估，现在提包等于提前抽象。

## 后果与防回退

- 新增任何监听必须同时：加白名单条目 + 加断言 + 在该 Note 说明触发条件与"打包不可达"；只加白名单不加断言会被架构检查拒绝。
- 环回监听不得被改造成通用本地服务（不接受任意路径、不接受长驻、不返回业务数据）；它只在一次登录期间存在。
- 打包版回归验证要包含"运行时不可达"：通道选择在打包分支走深链，且 `startLoopbackCallback` 在 `app.isPackaged` 下直接抛错（bundle 里存在这段代码是正常的，判断的是可达性）。
- 该例外不影响其余规则：main ↔ agent 仍走 `utilityProcess`，本地辅助二进制仍走 `stdio`，渲染层仍走 `DesktopBridge`。

## 验证

- `pnpm architecture:check` 通过：`loopbackCallback.ts` 命中白名单且断言齐备。
- 反向探针（沿用既有做法）：向 `packages/shared/src/__arch_probe.ts` 放 `createServer()` → 报"禁止在 src 中开启本地监听"；把白名单文件里的 `app.isPackaged` 改成 `app.isReady` → 报"本地监听例外缺少 打包版禁用 断言"（两处探针改动均已回滚）。
- `pnpm build` 通过：`out/main/index.cjs` 内含 `answra:auth:*`、`LOOPBACK_HOST`、`desktop-auth-pending` 等实现，通道在打包分支不可达。
- `apps/desktop/test/authService.test.ts` 用注入的假通道验证编排与通道形态无关；`authCallback.test.ts` 验证环回 URL 与深链 URL 都被正确接受为回调目标。
- 实机未验证：开发态走真实站点授权页的环回回跳（需要 AnswraSite 本地站点）。
