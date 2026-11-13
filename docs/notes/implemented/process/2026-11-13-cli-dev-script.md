# Note：CLI 开发态 `pnpm dev:cli` 入口

状态：已实施

## 问题

CLI 只有 `build`、`start` 与 `smoke:electron`：本地要用 TUI 必须先构建 `apps/cli/dist/main.mjs`，再手动设置 `ANSWRA_AI_BASE_URL` / `ANSWRA_MODEL` / `ANSWRA_API_KEY`。改一次源码就要重新构建，且仓库根已有 `.env` 约定（桌面端开发态自动加载），CLI 却没有对应的开发入口。直接 `node src/main.ts` 也跑不起来：源码是 TypeScript，工作区包 `exports` 指向 `.ts`，且源码使用无扩展名导入，Node 原生类型剥离无法解析。

## 涉及范围

- 代码/模块：根 `package.json`（新增 `dev:cli`）、`apps/cli/package.json`（新增 `dev` 与仅开发依赖 `tsx`）、`pnpm-lock.yaml`。
- 工程流程：`pnpm dev:cli` 直接运行 CLI 源码；TTY 下进入 Ink TUI。
- 不涉及：`apps/cli/src/**` 运行时源码、esbuild 构建脚本、发布 bundle 与安装包。
- 相关 Note：[桌面端开发态加载仓库根 .env](2026-10-19-desktop-dev-dotenv.md)、[CLI coding 模式与 TUI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)、[桌面端与 CLI 共享本地模型配置](../architecture/2026-11-13-shared-client-model-config.md)。

## 决定

根脚本只做转发，具体命令留在包内，与其他 `dev:*` 一致：

- 根：`"dev:cli": "pnpm --filter @answra/cli dev"`。
- CLI：`"dev": "node --import tsx --env-file-if-exists=../../.env src/main.ts code"`。
- `tsx` 只作为 `@answra/cli` 的 devDependency，不进入运行时依赖，也不进入 esbuild bundle。
- 生产/安装包仍以 `apps/cli/scripts/build.mjs` 产出的 `dist/main.mjs` 为唯一产物；`pnpm dev:cli` 不改变发布链路。
- 开发态从仓库根 `.env` 读取变量，已存在的 shell 环境变量优先（Node `--env-file*` 语义）；`.env` 不存在时继续启动。
- 参数透传沿用 pnpm：`pnpm dev:cli -- --no-alt-screen`、`pnpm dev:cli -- "解释这个仓库"`。

## 流程变化

本地开发 CLI 不再需要先 `build`：

```powershell
pnpm dev:cli
```

CLI 会优先读取 `--base-url` / `--model`、`ANSWRA_*` 环境变量，其次读取桌面端共享的 `Answra/config.json` 本地模型配置。只有共享配置不满足时才需要在仓库根 `.env` 写入 `ANSWRA_AI_BASE_URL`、`ANSWRA_MODEL`；需要鉴权时仍单独提供 `ANSWRA_API_KEY`（参考 `.env.example`）。发布与 smoke 仍走 `pnpm --filter @answra/cli build` / `smoke:electron`。

## 曾考虑的替代方案

- **开发态也先 build 再 `node dist/main.mjs`：** 舍弃。每次启动都多一步构建，改源码不会立即生效，不算开发入口；构建仍保留给 smoke 与发布。
- **自写 esbuild watch + 子进程重启脚本：** 舍弃。Ink TUI 正在交互时被文件监听自动重启，会破坏 alt-screen 与输入状态；自定义 watcher 还要额外维护 stdin 透传和退出码，收益低于标准 `tsx`。
- **`tsx watch`：** 舍弃作为默认入口。它适合普通 CLI，但会在保存文件时打断正在运行的 TUI；需要热重启时开发者可显式使用，不把它作为 `dev:cli` 的默认行为。
- **Node `--experimental-strip-types` / `process.loadEnvFile`：** 舍弃。源码大量无扩展名导入，原生类型剥离不提供 bundler 式解析；把 `.env` 读取写进 `src/main.ts` 又会让生产入口产生开发态副作用。
- **把 `tsx` 放到根依赖：** 舍弃。只有 CLI 开发需要，放在包内能明确依赖边界，也避免其他包误用第二套 TypeScript 执行器。
- **开发态直接解密桌面端 `conversation-model.json`：** 舍弃。密钥由 Electron `safeStorage` 加密，CLI 直接解密需要平台专属实现并扩大密钥暴露面；后续共享配置只迁移非 secret 字段，密钥仍不共享。

## 后果与防回退

- `tsx` 只能出现在 `@answra/cli` 的 devDependencies；不得被 `src/**` 导入，也不得替代 `build.mjs` 进入发布产物。
- `dev:cli` 的 `.env` 加载只属于开发脚本；生产入口（`src/main.ts` / `dist/main.mjs`）不得读取 `.env`，避免打包版配置来源失控。
- Node 下限保持 `>=22.13.0`：`--env-file-if-exists` 自 Node 22.9 起可用，不能把下限降到该版本以下。
- 不把 `tsx watch` 设为默认；若未来需要热重启，必须提供不破坏 TUI 交互的显式入口。

## 验证

- `pnpm dev:cli -- --help`：通过。tsx 成功解析 `src/main.ts`、Ink/TUI 与所有 workspace `.ts` exports，输出完整帮助。
- `pnpm dev:cli -- --version`：通过，输出 `answra 0.1.0`。
- `pnpm lint`、`pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/cli test`：通过。
- 真实 TTY 的 alt-screen、滚动与键盘交互仍按 TUI Note 的实机验收清单执行；本次只新增开发入口，不改变 TUI 行为。
