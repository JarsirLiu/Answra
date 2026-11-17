# Note：独立远程客户端会话入口

状态：提案

## 问题

当前远程连接由 host 与 controller 两个角色组成。CLI 已支持 `answra remote attach`，该命令启动一个独立远程 coding TUI，coding 命令、会话、工作区和模型设置均由远端 host 执行；本机负责终端输入、呈现与远程传输。CLI 的 `/remote` 则负责把当前 CLI 所在机器作为 host。

此前考虑在已有本机 TUI 中增加 `/connect` 与 `/disconnect`，让一个交互会话动态切换本机和远程目标。这会迫使每个命令明确本地/远程归属，也涉及 transcript、模型配置、会话历史、取消和断线期间目标语义。用户提出的“连接远程”与“启动远程 CLI”确实是不同模型：前者改变当前会话目标，后者创建一个从启动开始就以远端 host 为执行环境的客户端会话。

需要明确独立客户端会话是否意味着远程能力专属于 CLI。答案应为否：远程传输的 host/controller 契约属于平台无关的 `@answra/remote`，CLI 和桌面端都可以分别启动自己的 controller 会话接入；独立的是客户端会话入口和执行目标，不是远程协议、服务端能力或客户端程序类型。

## 涉及范围

- 代码/模块：现有 `apps/cli/src/cli/remoteSessionCommands.ts`、`apps/cli/src/remote/controller/`、`packages/remote/`；后续桌面接入涉及 `apps/desktop/src/main/`、preload/renderer 及必要的共享 IPC 契约。
- UI/进程/协议/持久化表面：远程 controller 客户端会话生命周期、凭据输入与存储、远程 host 上的 coding 执行、桌面端 controller 能力边界。
- 相关 Note：[CLI 持久远程连接码](../../implemented/feature/2026-11-14-persistent-cli-remote-connection-code.md)、[远程控制 P2P 信令](../architecture/2026-11-13-remote-control-p2p-signaling.md)。

## 提案

### 产品入口与日常流程

- `answra` 启动的普通 CLI 始终操作本机 workspace 和本机 Agent。TUI 不新增 `/connect`、`/disconnect`，也不动态切换 execution target。
- `answra connect` 是面向用户的短入口，启动独立远程 coding CLI 会话。首次使用时交互输入一次性连接码并完成配对；成功后保存本机受保护的 controller 凭据。以后无参数运行 `answra connect` 默认重连最近使用的 host；连接管理命令用于选择、重命名、移除或切换已配对的 host。
- `answra remote attach` 保留为 `answra connect` 的兼容别名，帮助已有文档、脚本和用户平滑迁移。新帮助和主要文档以 `answra connect` 为主。
- 远程会话建立后，coding 请求、工具执行、shell/workspace 上下文、会话历史和模型配置均由远端 host 承载；本地 CLI 只承担终端交互、呈现、连接生命周期和 controller 凭据。所有 coding slash 命令因此天然属于远端。
- `answra connections` 管理本机已配对的远程 host 与连接凭据，不列出 coding 会话。`/sessions`、`/new`、`/resume`、`/delete` 属于当前远端 host 的 coding 会话目录。两类列表分别以连接目标和工作会话为对象。
- `answra remote host` 启动本机 host 并显示连接码；TUI 中 `/remote` 可作为该 host 命令的快捷入口，负责启动/查看本机 host 与连接码，不承担连接到其他 host 的职责。
- 推荐日常流程：远端运行 `answra remote host` 并分享连接码；本地首次运行 `answra connect` 输入连接码，之后运行 `answra connect` 重连最近的 host；在远程 CLI 中用 `/new`、`/sessions`、`/resume` 管理远端 coding 会话；退出远程 CLI 后运行普通 `answra` 操作本机会话。需要选择其他已配对机器时，先用 `answra connections` 管理连接目标。
- 不在普通 CLI TUI 内增加 `/connect`、`/disconnect` 来隐式改写当前 transcript 或 Agent 的执行目标。远程是一个启动时确定的 CLI 上下文，而不是当前本地会话中的动态模式。

### 桌面端兼容

- 远程 host/controller 协议继续由 `@answra/remote` 定义，不能将 WebRTC、信令、握手和帧语义搬进 CLI 私有协议。
- 桌面端具备作为 controller 连接远程 host 的产品需求时，可在桌面应用内启动一个独立的远程会话，从桌面 main 提供平台适配，通过受类型约束的 IPC 暴露给 renderer；远端 coding host 仍执行命令，桌面只负责呈现/输入和连接生命周期。
- 桌面端远程会话不需要启动 CLI 子进程，也不要求把本机桌面会话动态改成远程目标。它可以表现为桌面应用中的独立窗口、独立工作区或独立会话，具体 UI 形态另行设计。凭据存储按宿主现有安全边界实现，不复用 CLI 明文配置或桌面登录令牌。
- 此提案确立协议与角色边界，不代表桌面端远程 controller UI 已经实现。桌面接入的交互、窗口生命周期、权限与凭据方案需在实际排期时单独定义并验证。

### 生命周期与安全

- `connect` 建立连接前读取所选 host 的已保存 controller 凭据；首次配对使用隐藏输入读取连接码，握手成功后再保存凭据。密钥不得进入 argv、transcript、日志或普通错误文本。若尚无已保存连接且没有连接码参数，应提示交互输入，而不是要求用户记住 `remote attach` 子命令。
- controller 连接断开时，远程 CLI 会话应明确退出或进入不可发送状态；不得静默回退到本机 Agent。
- 远程会话的模型设置由远端 host 权威管理，不得读取或改写本机 `/config` 与本地 API Key。
- CLI 与桌面端分别负责各自 controller 传输及资源释放；共享协议层不依赖 Electron、Node、React、Ink 或 Agent。

## 影响表面

- 在远端工作时，用户启动 `answra connect`，所有 coding 命令都指向远端 host，不需要在每条命令中判断本地/远程归属。
- 普通 `answra` 与 TUI slash 命令继续明确作用于本机，保持本地会话行为可预测。
- 本机连接列表（`answra connections`）与远程 coding 会话列表（`/sessions`）分离；连接目标选择不改变任一 host 内部的会话归属。
- 桌面端仍可成为 controller，并可启动自己的远程桌面会话；采用 CLI 独立会话模型不会限制桌面端连接，也不意味着桌面端自动获得此能力。
- `/remote` 继续作为 host 侧入口，host 与 controller 的入口职责清楚。

## 曾考虑的替代方案

- **在同一 CLI TUI 通过 `/connect` 动态切换本地/远端：** 每个命令和设置都要定义目标归属，且切换涉及 transcript、会话历史、取消、run 排队和断线语义；当前 `remote attach` 已证明独立远程 coding 会话可复用既有 `CodingSession`，因此不选动态切换。
- **只保留 `answra remote attach` 作为唯一用户入口：** 语义清晰但命令较长，需记住 `remote` 与 `attach` 两层；因此新增易记的 `answra connect` 作为主入口，并保留原命令兼容。
- **把连接列表与 coding 会话列表合并：** 两者生命周期和归属不同，连接列表属于本机 controller，coding 会话属于具体远端 host；合并会让连接管理操作看似操作会话或造成目标歧义，因此分开。
- **每次 `answra connect` 都必须重新输入连接码：** 连接码是配对凭据，不应成为日常重连步骤；在本机安全保存凭据后重连可减少操作，同时保留显式连接目标选择能力。
- **连接后启动第二个隐藏 CLI/TUI：** 会产生双重输入、输出与生命周期，难以明确哪个会话接收命令；不采用。
- **将远程 controller 实现为 CLI 专用能力：** 会无谓限制桌面端复用远程 host，且把平台无关的协议决策下沉到 CLI；继续把协议放在 `@answra/remote`，由宿主各自适配。
- **把桌面端 controller UI 纳入本次 CLI 提案并同步实现：** 桌面需要自己的 IPC、窗口、凭据和交互设计，超出 CLI 入口决策范围；本提案先固定可复用边界，桌面功能另行立项。

## 验收标准

- CLI 普通启动仍只连接本机 coding host；不存在运行时本地/远程 target 切换命令。
- `answra connect` 是新用户文档中的主要远程入口；首次配对读取连接码，后续可重连最近 host，`answra remote attach` 作为兼容别名工作。
- `answra connect` 启动独立远程 coding 会话；会话历史、workspace 相关工具、Agent 执行和模型设置均由远端 host 提供。
- `answra connections` 显示和管理已配对 host，不与远程 `/sessions` coding 会话列表混淆；退出远程 CLI 后执行普通 `answra` 可访问本机会话。
- 远端 `answra remote host` 与 host 侧 `/remote` 都只负责启动/管理本机 host 及连接码，不与 controller 的 `answra connect` 混用。
- 连接凭据安全输入与保存时机明确；握手失败不持久化凭据，连接断开不会将命令发送到本机 Agent。
- CLI 的 host/controller 继续通过平台无关 `@answra/remote` 契约协作，且远程 controller host 适配不依赖 TUI。
- 后续桌面 controller 可在不修改远程帧协议、不启动 CLI 子进程的情况下实现独立桌面会话适配；桌面实现完成前不得宣称桌面端已支持远程连接。
- CLI 自动化覆盖连接成功/失败、凭据保存时机、远端命令路由、断线 fail-closed 和 dispose；公网/NAT 实机验收单独记录，不把 fake 或 loopback 测试当作公网证据。

## 风险

- “远程 CLI”容易被误解为远端另起 CLI 进程。当前模型实际是本地 CLI 提供交互、远端 host 提供 coding 执行环境；`connect` 启动时和状态提示需清楚说明当前目标 host。
- `connect` 若只默认重连最近 host，多个已配对机器间切换可能不够明显；`answra connections` 必须提供明确的列出和选择路径，连接目标在启动时确认。
- 桌面端虽然保留协议层接入能力，但 UI、凭据管理和生命周期尚未实现。若未来桌面要连接远程，应按桌面进程边界接入，不能直接复用 CLI 的 TUI/存储模块。
- 当前 P2P 没有 TURN 和自动重连；公司网络可能限制 UDP/NAT。连接失败必须如实呈现，不能假定独立进程模型会改善网络可达性。
- 连接码等同远程 coding/shell 控制凭据；任何 UI、错误、历史或日志泄漏都构成授权泄漏。

## 验证与防回退

本 Note 是架构与产品行为提案，不代表新增功能已实施。评审通过后，实施变更应迁移/改写为 `implemented` Note，并记录 CLI 自动化及两台真实设备网络验证证据。实现前需验证 `connect` 的首次配对、最近 host 重连、多 host 选择、连接凭据删除，以及远程 coding 会话和本机连接列表的分离。若后续要在普通 CLI TUI 内增加动态目标切换，必须单独论证命令归属、transcript、会话、取消与断线语义，不得把它作为 `connect` 的隐式副作用。
