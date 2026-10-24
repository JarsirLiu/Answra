# 会议辅助工具

面向办公会议场景的本地优先桌面助手，使用 React、TypeScript 和 Electron 构建界面。

## 当前范围

- 三段式悬浮导航：模式选择、模式功能、笔记/资料/设置等全局入口。
- 按需展开的对话、笔记、参考资料和设置面板。
- 支持应用内区域截图、添加本地图片、填写补充问题并作为同一条消息发送。
- 对话回复为演示内容，尚未连接后端或 AI 模型。
- Windows 面试语音试用接入会议系统声音与候选人麦克风，经本地 VAD/ASR 后在面板按说话方显示识别文本和 VAD 端点；当前不生成回答。
- 隐身模式通过 Electron 窗口捕获保护请求系统排除应用表面；实际效果需按 Electron 和 Windows 版本验证。

工程决策、功能方案、缺陷复盘和架构边界统一记录在[工程 Note](docs/README.md)。

## 环境要求

- Node.js 22.13 或更新版本（pnpm 11.9 的最低要求）
- pnpm 11.9.0，建议通过 Corepack 管理
- Windows 可运行原生 Electron 桌面窗口；其他平台可通过 `pnpm dev:web` 预览 renderer

## 开发

```powershell
corepack enable
pnpm bootstrap
pnpm --filter @answra/desktop vad:prepare
pnpm --filter @answra/desktop asr:prepare
pnpm dev
```

`pnpm bootstrap` 是统一的环境初始化入口：安装 workspace 依赖，并校验/通过 npmmirror 镜像补齐 Electron 二进制，避免 `pnpm dev` 启动时才临时下载卡住。`pnpm dev` 会同时启动 Vite 和 Electron。使用 `pnpm dev:web` 可只启动浏览器预览。桌面开发窗口使用 5180 端口；端口被占用时命令会报错退出，不会静默换端口。

面试语音运行还需要 TEN VAD 与 Paraformer 模型。上面两条 prepare 命令会下载并校验资源；ASR 模型约 82 MB，支持断点续传。`bootstrap` 不包含这两类语音资源。国内网络下 Rime/VAD 的 GitHub 源可能较慢或失败，ASR 使用 hf-mirror；网络恢复后可重跑对应命令。

### 内置输入法资源

librime、词库和 helper 二进制不提交 Git。`pnpm bootstrap` 和打包前都会自动执行资源下载、SHA-256 校验和整理，无需手动拷贝文件：

```powershell
pnpm --filter @answra/desktop ime:prepare
pnpm dev                 # 开发测试
pnpm dist:win            # Windows 发布包
```

`ime:prepare` 根据 [`rime-resources.json`](apps/desktop/native/rime-resources.json) 下载固定版本的官方 librime MSVC x64/macOS universal 包、依赖包及词库源码归档。下载内容先通过 SHA-256 校验，再解压至忽略 Git 的本地资源目录；Windows 使用 workspace 内的 `7zip-bin` 解压官方 7z 包。开发机不需要安装 CMake，也不会编译 helper。

输入方案为简体 `luna_pinyin_simp`。基础词库使用官方 `rime-luna-pinyin`
（拼音词典）和 `rime-essay`（常用词/语言模型）。英文联想使用上游
`BlindingDark/rime-easy-en` 的 `easy_en` schema/dict，并通过
`luna_pinyin_simp.custom.yaml` 接入中英混输。

资源更新只改清单中的固定版本、下载 URL 和 SHA-256，并同步检查对应许可证。项目 helper 由 `.github/workflows/rime-host-release.yml` 在 `rime-resources.json` 声明的 tag（当前 `answra-rime-host-v2.0.0`）上构建并发布为 Windows x64 与 macOS universal 资产及 `SHA256SUMS`；准备脚本只接受该固定 release tag，并按 sidecar 中的摘要校验 helper。更新 helper 时必须先发布对应 tag 的 release，再改清单；release 缺失或摘要不符时 `ime:prepare` 会 fail-closed 失败，不会回退到系统输入法。不要运行 CMake，也不要手工修改用户目录下的 `rime/build`；首次启动会由 librime 按当前资源重新部署 schema。

Windows/macOS 发布机分别执行 `pnpm bootstrap` 后再打包，准备脚本只下载当前目标平台的运行库和 helper。下载缓存位于 `apps/desktop/.cache-rime/`，运行时资源位于 `apps/desktop/resources/rime/`，二者都不提交 Git。

## 检查

```powershell
pnpm verify   # lint + typecheck + test + architecture:check（Note 检查仅提示，不阻断）
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
apps/agent             平台无关的 Agent 运行时（不依赖 Electron/React），由 desktop 的 utility process 拉起
  src/index.ts         公共入口：desktop worker 的唯一导入面
  src/worker           worker 线协议（main ↔ agent 命令与帧）
  src/conversation     会话运行时与存储端口；新增领域（转写、工具、触发）平级加目录
examples/vad-asr-eval  可选真实样本 VAD/ASR 评测：原句与链路转录并排、人工审阅及 turn 延迟；不生成回答、不进常规门禁
scripts/architecture   架构守护脚本（深导入/依赖环/平台越界检查）
scripts/docs           文档门禁
.agents/skills         AI 开发流程指南
docs/notes             按生命周期与类别管理的工程 Note
docs                   Note 索引
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 环境初始化：安装依赖 + 补齐 Electron 二进制 + 下载并校验内置输入法资源 |
| `pnpm dev` | 启动 Vite + Electron（先构建 main/preload bundle） |
| `pnpm --filter @answra/desktop ime:prepare` | 下载、SHA-256 校验并整理当前平台的 librime/helper 与词库资源 |
| `pnpm --filter @answra/desktop vad:prepare` | 下载并校验 TEN VAD 运行资源 |
| `pnpm --filter @answra/desktop asr:prepare` | 下载并校验本地 Paraformer ASR 模型 |
| `pnpm build` | 全 workspace 构建（desktop: esbuild + vite） |
| `pnpm typecheck` | 各包依次 `tsc --noEmit`（desktop 按进程分三个编译单元） |
| `pnpm test` | 各包测试（ui 使用 vitest + jsdom） |
| `pnpm notes:hint` | Note 格式、本地链接和变更配对检查（仅提示，不阻断） |
| `pnpm notes:check` | 同 `notes:hint` 但严格：缺失或格式错误即失败（CI/发布用） |
| `pnpm architecture:check` | 架构守护检查 |
| `pnpm --filter @answra/vad-asr-eval eval:eot` | 可选运行真实中文轮次 VAD/ASR 评测，结果在 `examples/vad-asr-eval/out/` |
| `pnpm verify` | lint + typecheck + test + architecture（Note 检查为提示；pre-push 同款） |

## 参与开发

- 包结构、依赖方向、IPC 约定见 [AGENTS.md](AGENTS.md)；改动须通过 `pnpm verify` 与架构守护脚本。
- 重要交互变化需补充或更新测试（`packages/ui/test/`）。
- 不要将凭据、本机数据或生成的安装包提交到 Git。
- 向本仓库提交更改或 PR，即表示你同意该贡献按 [LICENSE](LICENSE) 授权发布。

## 许可

本项目源码按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权：个人学习、研究、非商业机构等任何非商业用途免费使用；**任何商业用途都需要另行获得授权**（通过 [Issues](https://github.com/JarsirLiu/Answra/issues) 联系）。仓库内的第三方输入法等资源遵循其上游声明的许可，见 `apps/desktop/native/rime-resources.json` 的来源与版本清单。
