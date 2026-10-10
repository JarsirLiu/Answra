# 笔试助手

面向笔试练习的本地优先桌面助手。当前阶段聚焦 Electron 桌面交互原型，使用 React、TypeScript 和 Vite 构建界面。

## 当前范围

- 三段式悬浮导航：模式选择、模式功能、笔记/资料/设置等全局入口。
- 按需展开的对话、笔记、参考资料和设置面板。
- 笔试模式支持添加本地截图、填写补充问题并作为同一条消息发送。
- 对话回复为演示内容，尚未连接后端或 AI 模型。
- 当前不进行桌面截屏、麦克风、摄像头或系统音频采集。

运行边界和阶段规划见[架构方案](docs/ARCHITECTURE.md)，悬浮导航交互见[交互方案](docs/FLOATING-BAR-INTERACTION.md)。

## 环境要求

- Node.js 22.12 或更新版本
- pnpm 11.9.0，建议通过 Corepack 管理
- Windows 可运行原生 Electron 桌面窗口；其他平台可通过 `pnpm dev:web` 预览 renderer

## 开发

```powershell
corepack enable
pnpm bootstrap
pnpm dev
```

`pnpm bootstrap` 是统一的环境初始化入口：安装 workspace 依赖，并校验/通过 npmmirror 镜像补齐 Electron 二进制，避免 `pnpm dev` 启动时才临时下载卡住。`pnpm dev` 会同时启动 Vite 和 Electron。使用 `pnpm dev:web` 可只启动浏览器预览。桌面开发窗口使用 5180 端口；端口被占用时命令会报错退出，不会静默换端口。

## 检查

```powershell
pnpm verify   # lint + typecheck + test + architecture:check
pnpm build
```

Windows 安装包通过 `pnpm dist:win` 构建，当前为未签名的 NSIS 安装包，不需要代码签名证书。

## 仓库结构

pnpm workspace monorepo，按 ZCode 的团队协作标准组织：包间依赖只走 `workspace:*` 与各包 `exports` 声明的公开入口；IPC 频道与载荷类型集中在 `@answra/shared`；渲染层 UI 与平台能力（DesktopBridge）解耦，`packages/ui` 不允许直接接触 Electron。

```text
packages/shared        跨进程契约：IPC 频道常量 + ChannelMap 类型、环境变量常量、领域类型
packages/ui            悬浮条与面板的全部业务 UI（React），含组件测试
apps/desktop           Electron 桌面壳
  src/main             主进程：窗口管理、按领域拆分的 IPC handler
  src/preload          contextBridge 桥（window.answra）
  src/renderer         薄渲染层：仅挂载 <FloatingBarApp/>
scripts/architecture   架构守护脚本（深导入/依赖环/平台越界检查）
docs                   架构与交互决策
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 环境初始化：安装依赖 + 校验/补齐 Electron 二进制 |
| `pnpm dev` | 启动 Vite + Electron（先构建 main/preload bundle） |
| `pnpm build` | 全 workspace 构建（desktop: esbuild + vite） |
| `pnpm typecheck` | 各包依次 `tsc --noEmit`（desktop 按进程分三个编译单元） |
| `pnpm test` | 各包测试（ui 使用 vitest + jsdom） |
| `pnpm architecture:check` | 架构守护检查 |
| `pnpm verify` | lint + typecheck + test + architecture（pre-push 同款） |

## 参与开发

- 包结构、依赖方向、IPC 约定见 [AGENTS.md](AGENTS.md)；改动须通过 `pnpm verify` 与架构守护脚本。
- 重要交互变化需补充或更新测试（`packages/ui/test/`）。
- 不要将凭据、本机数据或生成的安装包提交到 Git。
