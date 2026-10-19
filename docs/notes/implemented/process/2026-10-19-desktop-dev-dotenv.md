# Note：桌面端开发态加载仓库根 .env

状态：已实施

## 问题

桌面端云端地址由 `apps/desktop/src/main/auth/config.ts` 的 `resolveCloudEndpoints` 决定：打包版用内置默认地址，开发态允许通过 `ANSWRA_CLOUD_API_BASE_URL` / `ANSWRA_CLOUD_SITE_BASE_URL` 覆盖（仅限 http 环回）。但 Electron main 进程不读取任何 `.env` 文件，而 `pnpm dev` 的 cwd 是 `apps/desktop`，且 Electron 由 `concurrently`/`wait-on` 拉起，逐条在 shell 里 `export` 再启动既繁琐又不可复现。本地联调网站（`http://127.0.0.1:3100`）与网关（`http://127.0.0.1:8080`）登录链路时，开发态覆盖值没有稳定入口。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/devEnv.ts`（新增）、`apps/desktop/src/main/index.ts`（在 `resolveCloudEndpoints` 之前调用）、`apps/desktop/test/devEnv.test.ts`（新增）。
- 工程流程：`pnpm dev` 启动的 Electron main 现在会自动加载仓库根 `.env`。
- 相关约定：`packages/shared/src/env.ts` 中的变量命名约束；`.env` 已被 `.gitignore` 忽略，`.env.example` 提供样例。

## 决定

新增 `devEnv.ts`：开发态（`!app.isPackaged`）在 main 进程模块初始化阶段、解析云端地址之前，从 `process.cwd()` 向上查找 `.git` 定位仓库根，读取根目录 `.env` 并注入 `process.env`。规则：

- 只在未打包构建中调用，打包版完全不受影响（沿用 `config.ts` 的防篡改约束）。
- 已存在的环境变量不覆盖（shell 显式设置的值优先于 `.env`）。
- 地址能否生效仍由 `resolveDevOverride` 把关：只有 http 环回地址被接受，远端地址一律回落默认。
- 不引入 `dotenv` 依赖，解析逻辑自包含（`KEY=VALUE`、`#` 注释、引号剥离、`\n` 转义、CRLF）。
- 从 `.git` 标记向上定位仓库根，避免向上逃逸到仓库外的任意目录；找不到 `.env` 或 `.git` 时静默跳过。

## 流程变化

`pnpm dev` 启动的 Electron main 进程会自动加载仓库根 `.env`（仅开发态）。本地联调前需在仓库根创建 `.env`（`.gitignore` 已忽略），写入 `ANSWRA_CLOUD_SITE_BASE_URL` / `ANSWRA_CLOUD_API_BASE_URL` 指向本地站点与网关；不再需要通过 shell 逐条 export。`.env.example` 保持逐项注释更新。

## 曾考虑的替代方案

- **在 shell 脚本 / `concurrently` 里逐条注入环境变量：** 舍弃。跨 Windows/macOS 维护成本高，且无法随仓库提交样例值；`.env` 是各端通行的开发者习惯。
- **引入 `dotenv` 包并在 dev 依赖里加载：** 舍弃。所需语义只有「不覆盖、注释、引号」，30 行自包含实现即可，减少 main bundle 依赖面。
- **让 `resolveCloudEndpoints` 自己读 `.env`：** 舍弃。该函数已有单测且被 `index.ts` 之外的测试直接调用；加载 `.env` 是进程级副作用，应在入口最早阶段一次性完成，与端点解析解耦。
- **读取 `apps/desktop/.env` 而非仓库根：** 舍弃。仓库根 `.env` 是跨包共享入口（`.env.example` 已在根目录），子包再放一份会造成两个事实来源。

## 后果与防回退

- 开发者本地联调需在仓库根创建 `.env`（参考 `.env.example`），该文件不入 Git。
- 打包版永远不会读取 `.env`；生产地址防篡改约束不因本变更放松。
- 环境变量优先级固定为「shell/启动环境 > 仓库根 `.env` > 默认值」，调整时不得让 `.env` 覆盖已有环境变量。
- 若未来 shared 新增 dev-only 变量，也走同一入口注入，不得再散落新的 `process.env` 读取点。

## 验证

- `apps/desktop/test/devEnv.test.ts` 7 个用例覆盖：解析（注释/空白/引号/转义/非法行/CRLF）、按 `.git` 向上定位、仓库外放弃、缺失变量注入且不覆盖已有值、无 `.env` 时无操作。`pnpm --filter @answra/desktop test -- devEnv` 全部通过。
- 端到端联调（Windows，本地）：网关 `:8080/health` 200；`POST http://127.0.0.1:3100/api/auth/login`（管理员账号）200 并下发会话 Cookie；`POST http://127.0.0.1:3100/api/desktop/authorize` 200 返回一次性 code；`POST http://127.0.0.1:8080/api/v1/auth/desktop/exchange` 200 返回 `device_access_token` / `device_refresh_token`。登录契约本身无需修改。
