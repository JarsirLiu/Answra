# Note：桌面端架构边界

状态：已实施

## 问题

桌面应用同时包含 React 界面、Electron 原生窗口和跨进程通信，需要明确模块职责，避免 UI 直接持有平台能力或窗口生命周期。

## 决定

采用 shared、ui、desktop 的单向依赖；Electron 主进程拥有窗口生命周期，preload 只转发受限 API，renderer 通过类型化 DesktopBridge 表达意图。本文后续章节保留架构说明和阶段边界。

## 涉及范围

- `packages/shared`：跨进程与跨包契约。
- `packages/ui`：平台无关的 React 界面。
- `apps/desktop/src/main`、`src/preload`、`src/renderer`：平台能力、桥接和渲染入口。

## 模块边界

- `@answra/shared` 定义跨包类型、IPC 通道和纯共享能力。
- `@answra/ui` 组合可注入平台桥的 React 界面，不依赖 Electron/Node。
- `@answra/desktop` 拥有 main、preload 和 renderer 壳；main 是原生窗口与系统能力的唯一所有者。

## 曾考虑的替代方案

- **所有 UI 放在 desktop 包：** 会让纯 UI 与 Electron 平台绑定，难以在浏览器预览和独立测试。
- **一开始拆出 API、存储或更多 workspace package：** 当前没有第二个真实消费者，额外包会增加维护面而不形成实际隔离。
- **renderer 直接管理窗口：** 会越过进程安全边界，也让窗口策略散落在多个 UI 功能中。

## 后果与防回退

- 增加跨进程能力时要同步维护 shared 契约、preload 转发、main 校验和测试。
- 当前架构仍允许导航和普通面板共用主窗口；需要独立窗口行为的工作流由 main 明确创建独立窗口。
- 加入真实模型、持久化或媒体采集前，必须另行定义权限、数据和服务生命周期边界。

## 验证

- `pnpm architecture:check` 检查 workspace 环、跨包深导入和平台依赖越界。
- UI 行为由 `packages/ui/test/` 覆盖，桌面 IPC 和窗口策略由 `apps/desktop/test/` 覆盖。

## 考虑过的替代方案

- **把所有代码放入 desktop 包：** 会将 UI 与 Electron 绑定，无法独立做浏览器预览和组件测试。
- **按未来设想预先拆分 API 与数据服务：** 当前没有消费者和已确认契约，提前拆分只增加发布与运行复杂度。
- **将 Electron API 直接暴露给 renderer：** 会扩大渲染层权限并破坏进程隔离，因此只暴露最小的类型化 bridge。

## 后果与防回退

- 新增平台能力必须由 main 实现，并经过 shared 契约和 preload 许可名单；不得从 UI 深导入 Electron。
- 只有真实第二消费者或明确的独立部署边界才新增 workspace package。

## 产品边界

应用面向经常参加办公会议的用户，提供悬浮导航、模式入口、对话、笔记、资料和截图提问等辅助界面。当前会话与回复仍是演示流程；接入真实模型、麦克风、摄像头或系统音频前，需要单独定义产品行为、权限和数据边界。

产品采用本地优先路线。未来可以在用户电脑上运行本地 API 和模型适配器；这是后续能力，不是启动当前原型的前提。

## 运行结构

```text
apps/desktop
  electron/main.cjs       Electron 生命周期、窗口策略和原生能力
  electron/preload.cjs    精简并校验后的 renderer 桥接接口
  src/                    React renderer 和界面状态
```

仓库从一开始使用 pnpm workspace，但 `apps/desktop` 是当前唯一可部署应用。只有出现第二个真实消费者或明确的独立版本边界时，才新增应用或 package，避免为了形式过早拆分。

架构借鉴 OpenMuse 对 Electron 主进程、preload 和 renderer 的职责隔离；不复制其移动端、API、数据库、后台任务或托管服务依赖，因为本项目当前范围不需要这些部分。

## 窗口模型

主导航和二级面板使用一个透明、无边框、置顶的 `BrowserWindow`，主进程依据面板模式调整窗口高度。截图后的持久任务工作流使用单独的回复 `BrowserWindow`：主渲染器持有草稿与附件状态，通过类型化 IPC 同步；回复窗口只呈现任务条并回传用户动作。它有独立 HWND、尺寸和捕获保护生命周期，不参与主导航窗口的 resize。当前窗口与捕获行为以[Electron 捕获保护兼容性 Note](../bug-fix/2026-10-11-electron-capture-protection-compatibility.md)为准。

Electron 主进程是窗口生命周期的唯一所有者。renderer 通过 IPC 发送有限枚举值，主进程将其映射到预先确定的窗口尺寸；不接受 renderer 传入的任意边界坐标、URL、文件路径或命令。持续启用 `contextIsolation` 和 `sandbox`，关闭 Node integration。

除任务回复窗口外，导航和面板仍共用主窗口。若后续拆分其他界面，仍由主进程统一管理窗口，并通过有类型的事件通信；renderer 之间不直接互发消息。

## Renderer 与功能边界

renderer 负责呈现界面和原型阶段的临时状态。对话、笔记、资料和设置以独立界面模块组合在桌面应用中。长期持久化不能依赖 renderer 的 `localStorage` 作为稳定接口；真正加入持久化时，应通过有版本管理的本地 API 或基于 Electron `userData` 的受限 preload 接口完成。

对话界面是模型接入边界。消息呈现和输入框交互不应依赖特定模型传输方式。AI 阶段再评估 CopilotKit React UI/headless API 与 AG-UI 兼容运行时，通过本地 runtime/API adapter 接入。应用功能不直接依赖 CopilotKit 内部实现，也不要求云端订阅。当前原型使用确定性的演示回复，并明确标出未接入状态。

## 后续本地 API

排入真实 AI、设置或持久化项目后，再新增可独立测试的 `apps/api` 或同类 runtime package。Electron 主进程负责监管服务生命周期；服务只绑定到 `127.0.0.1` 的可用端口，并把最终地址传给 renderer，应用退出时停止服务。应用数据保存在 Electron 的 `userData` 目录下。模型供应商凭据应尽量使用操作系统安全存储，不能写进 renderer bundle 或提交到仓库。

本地运行 API 不等同于完全离线推理：如果模型配置指向托管供应商，请明确说明它会联网。后续可以独立增加本地推理服务。

## 质量与发布

- renderer 使用 TypeScript strict mode；Electron 主进程和 preload 使用开启严格检查的 JavaScript。
- 使用 Biome 统一格式和 lint；使用 Vitest 与 Testing Library 验证关键 renderer 交互。
- CI 使用仓库指定的 pnpm 版本，执行 lint、类型检查、测试和生产构建。安装包构建单独安排 Windows job，因为它需要下载 Electron 等运行时文件。
- Electron 版本会影响 Windows 原生窗口捕获行为；升级时必须运行桌面捕获验证并更新对应规格，不能只以类型检查或单元测试通过作为兼容性依据。
- 保持 renderer sandbox 开启，只经 preload 暴露有类型且经过许可名单限制的能力；主进程校验所有 IPC 参数。
- 初始 Windows 分发可以不签名，代码签名不是架构前提。发布前验证便携版/安装包，并说明 Windows SmartScreen 提示。
- 引入公开发布的独立 package 后，使用 Changesets 管理版本；桌面应用本身按 tag 发布即可。

## 交付阶段

1. **桌面交互原型**：三段式悬浮导航、模式入口、截图附件与补充提问流程、笔记/资料/设置面板和交互测试；无后端、无系统级设备采集。
2. **本地运行时契约**：确定本地 API 和会话协议，验证 CopilotKit/AG-UI 接入方式，设计设置、加载、失败等状态。
3. **本地持久化与模型供应商**：受主进程监管的 loopback API、用户数据存储、模型配置和密钥存储。
4. **Windows 发布**：自包含未签名安装包、安装与升级检查、崩溃日志和首次启动文档。

每个阶段分别验收；后续阶段不能在没有说明的情况下扩大原型权限或网络行为。
