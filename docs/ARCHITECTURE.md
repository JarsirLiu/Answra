# 桌面端架构方案

## 产品边界

第一阶段是笔试助手桌面交互原型，包含三段式悬浮导航、模式功能入口，以及按需展开的对话、笔记和资料面板。原型不截取桌面画面、不采集麦克风/摄像头/系统音频，也不调用本地或远程模型。界面中的会话和回复仅用于演示。

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

原型使用一个透明、无边框、置顶的 `BrowserWindow`。三段导航和当前内容面板位于同一个 renderer，主进程依据面板模式调整窗口高度。这样可以让焦点、键盘输入和面板关闭行为保持一致，也不需要在交互仍变化时同步多个窗口的状态。

Electron 主进程是窗口生命周期的唯一所有者。renderer 通过 IPC 发送有限枚举值，主进程将其映射到预先确定的窗口尺寸；不接受 renderer 传入的任意边界坐标、URL、文件路径或命令。持续启用 `contextIsolation` 和 `sandbox`，关闭 Node integration。

只有当用户测试证明导航必须独立移动，或单窗口无法可靠处理面板尺寸和焦点时，才重新评估拆分导航窗和面板窗。若拆窗，仍由主进程统一管理窗口，并通过有类型的事件通信；renderer 之间不直接互发消息。

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
- 保持 renderer sandbox 开启，只经 preload 暴露有类型且经过许可名单限制的能力；主进程校验所有 IPC 参数。
- 初始 Windows 分发可以不签名，代码签名不是架构前提。发布前验证便携版/安装包，并说明 Windows SmartScreen 提示。
- 引入公开发布的独立 package 后，使用 Changesets 管理版本；桌面应用本身按 tag 发布即可。

## 交付阶段

1. **桌面交互原型**：三段式悬浮导航、模式入口、截图附件与补充提问流程、笔记/资料/设置面板和交互测试；无后端、无系统级设备采集。
2. **本地运行时契约**：确定本地 API 和会话协议，验证 CopilotKit/AG-UI 接入方式，设计设置、加载、失败等状态。
3. **本地持久化与模型供应商**：受主进程监管的 loopback API、用户数据存储、模型配置和密钥存储。
4. **Windows 发布**：自包含未签名安装包、安装与升级检查、崩溃日志和首次启动文档。

每个阶段分别验收；后续阶段不能在没有说明的情况下扩大原型权限或网络行为。
