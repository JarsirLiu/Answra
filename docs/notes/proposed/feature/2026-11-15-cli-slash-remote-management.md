# Note：CLI 斜杠命令统一管理远程连接

状态：提案

## 问题

当前 CLI 的远程能力分散在两套入口：TUI 中的 `/remote` 只能启动本机 host，连接另一台设备和撤销密钥还要退出 TUI 后执行 `answra remote attach`、`answra remote key revoke <Key ID>` 等命令。用户在有对话的情况下无法用同一套交互完成远程连接、查看状态、切换连接和撤销授权，也不应被要求记住或手工输入 `Key ID`。

现有持久连接码和 host/controller 协议已经具备长期有效、重启复用和主动撤销能力。本提案只改变 CLI 的产品入口和会话编排，不改变连接码的安全含义，也不把连接码改成短期内存状态。

## 涉及范围

- CLI TUI 斜杠命令目录、解析和帮助文案。
- CLI TUI 远程管理面板及表单交互。
- CLI 组合根注入的远程管理端口、host 生命周期和 controller 会话切换。
- 远程凭据和 host key 的现有持久化实现及撤销语义。
- CLI 远程命令的兼容入口、测试和用户文档。

不涉及 AnswraSite 信令协议、WebRTC 实现、连接码格式、服务端登录流程或 SSH。

## 提案

### 1. `/remote` 成为唯一主要入口

在 coding TUI 中输入 `/remote` 打开“远程连接”面板，而不是直接输出一条撤销命令。面板按当前状态显示可用动作：

- **本机共享**：启动或停止 host；首次启动显示一次完整连接码，并提供复制；后续启动只显示“已恢复持久连接”，不重新生成或猜测 secret。
- **连接设备**：打开隐藏输入表单，粘贴完整连接码；握手成功后才写入本机 controller 凭据，并切换当前 coding 会话到远程 host。
- **已保存连接**：显示已保存连接的安全摘要、连接状态和最后一次错误；不显示 secret。
- **撤销本机共享**：列出本机 active host key，用户选择连接记录后确认撤销；界面不要求输入 Key ID。
- **断开当前远程会话**：关闭 controller 会话并回到本机 coding 目标；不会删除已保存凭据。

可支持 `/remote status`、`/remote host`、`/remote connect`、`/remote disconnect`、`/remote revoke` 作为快捷形式，但它们都进入同一面板或同一套 handler，不再复制一套业务逻辑。`/remote` 无参数始终打开面板。

### 2. 连接码输入必须是表单输入，不走命令行参数

连接码输入使用现有 TUI 的 secret 输入能力：不回显、不写入历史、不出现在 shell history 或普通日志中。输入格式错误只显示明确错误；握手失败时不落盘；只有收到 host welcome 后才保存 controller 凭据。

### 3. 远程会话是当前 coding 目标的切换

连接成功后，当前 TUI 不再启动第二个独立终端，也不要求用户重新执行 `remote attach`。会话层引入一个窄的 coding target 端口，由本机 target 和 remote controller target 分别实现。`/remote connect` 完成后替换当前 target，保留同一个 TUI 输入、命令、取消和退出生命周期。

断开远程会话时关闭 controller transport，恢复本机 target；远程 transcript 不与本机 transcript 静默拼接，切换时必须由 TUI 明确显示当前目标和工作区。

### 4. 生命周期由 TUI 统一收口

`/remote` 面板关闭不停止已经运行的 host；TUI 退出时停止本进程启动的在线 host，但保留永久连接码记录。controller 断开只关闭当前连接，不删除保存的连接凭据。Host key 仍由持久化 host key store 保存哈希，撤销优先于有效期判断。

### 5. 独立 CLI 命令保留为兼容和恢复入口

`answra remote host`、`answra remote attach`、`answra remote key ...` 暂时保留，用于脚本、无 TTY 环境和 TUI 无法启动时的恢复。帮助文案将它们标记为高级/兼容入口，主要用户流程只展示 `/remote`。`remote key revoke <Key ID>` 不再出现在 `/remote` 的普通提示中；底层命令保留以避免已有自动化失效。

## 影响表面

- `/remote` 面板成为 coding TUI 中远程 host、controller、状态、断开和撤销的统一入口。
- 连接码输入、撤销确认和已保存连接选择都在面板内完成，不要求用户输入 `Key ID` 或退出 TUI。
- 远程连接成功后，当前 TUI 的 coding target 切换为 controller target，并在状态行显示远程工作区；断开后可恢复本机 target。
- `answra remote ...` 继续作为无 TTY、脚本和恢复入口，但不再是普通用户的主要流程。

## 交互流程

### 本机共享

1. 用户在 coding 对话中输入 `/remote`。
2. 面板读取 host key store、host 在线状态和当前 controller 状态。
3. 用户选择“开启本机共享”。
4. 首次创建永久连接码时显示连接码、复制动作和撤销入口；secret 仅在创建结果中出现。
5. 用户返回对话，面板状态行显示“本机共享已开启”。

### 另一台设备连接

1. 用户在另一台 CLI 输入 `/remote`，选择“连接设备”。
2. 面板打开隐藏输入框，用户粘贴连接码并提交。
3. CLI 通过生产信令服务建立 controller，显示连接中、成功或明确失败状态。
4. welcome 成功后保存凭据并切换当前 coding target；失败不写入凭据。

### 撤销和断开

1. Host 侧打开 `/remote`，选择“本机共享”中的连接记录。
2. 选择“撤销连接码”后显示确认步骤，确认后调用 host key store revoke。
3. 已建立的连接按协议收到拒绝/关闭结果，后续重连失败。
4. controller 侧“断开”只结束当前会话；“删除已保存连接”才清理本机凭据。

## 模块边界

- `apps/cli/src/tui/commands`：只负责 `/remote` 命令元数据和分派，不实现远程协议。
- `apps/cli/src/tui/commands/RemotePanel.tsx` 及同目录表单模块：只负责展示、键盘交互和校验结果投影。
- `apps/cli/src/tui/panel.ts`：增加 `remote` 面板类型和窄的 `RemotePanelHandlers`。
- `apps/cli/src/tui/runTui.tsx`：注入远程管理端口、协调面板和当前 coding target 生命周期。
- `apps/cli/src/cli/remoteSessionCommands.ts`：保留 host/controller 组合逻辑，拆出可供 TUI 调用的管理用例；不让面板 import 远程包。
- `apps/cli/src/cli/dependencies.ts`：注入远程管理端口和 target 切换端口。
- `packages/remote`：继续只负责连接协议、访问密钥和状态机；不加入 Ink/TUI 逻辑。

## 曾考虑的替代方案

- **继续要求 `answra remote attach` 和 `key revoke <Key ID>`**：实现成本最低，但远程能力仍割裂在 TUI 和外部命令之间，无法满足对话中的统一操作，舍弃为主要入口，仅保留兼容。
- **在 TUI 中直接拼接并执行 CLI 子命令**：会产生第二套参数解析和错误生命周期，无法正确复用当前 session，也会把 secret 重新暴露到进程参数边界，舍弃。
- **为每个远程动作增加独立 slash 命令和独立面板**：用户需要记忆更多命令，状态会分散；统一 `/remote` 面板更符合远程操作是一个状态域的事实，舍弃。
- **短数字配对码和服务端 pairing**：需要新增网站/信令服务端持久化、轮询、限流和撤销 API；当前持久高熵连接码协议已满足需求，本提案不扩大服务端范围。

## 后果

- 用户可以在不中断当前 TUI 的情况下完成远程 host、连接、断开、查看和撤销。
- 当前 coding session 需要支持 target 切换，涉及会话生命周期和状态行展示，工作量高于增加一个简单面板。
- 独立 `remote` 子命令会暂时与 slash 面板并存，直到无 TTY 和脚本使用场景有新的替代方案。
- 永久连接码仍等同远程控制凭据；界面必须限制 secret 的显示次数，日志和 transcript 不得记录完整连接码。

## 实施阶段

1. 先补 TUI 远程管理端口、`remote` 面板契约和 fake port，覆盖状态读取、连接码隐藏输入、撤销确认和错误投影。
2. 将当前 `/remote` 直接启动逻辑迁移到面板的“本机共享”流程，保留 host 生命周期和持久 key 语义。
3. 将 controller attach 组合逻辑适配为当前 coding target，完成同一 TUI 内连接和断开。
4. 补充 `/remote status|host|connect|disconnect|revoke` 快捷参数、帮助文案和兼容命令提示。
5. 运行 CLI/Remote 测试、typecheck、Biome、架构检查、Note 检查，并在两台 Windows CLI 通过生产信令验证重启复用、自动重连、断开和撤销。

## 验收标准

- 用户只通过 `/remote` 面板即可完成 host 开启、连接码输入、controller 连接、状态查看、断开和撤销。
- 连接码输入不回显、不进输入历史；握手失败不产生本地凭据。
- Host 重启后复用同一持久连接码；TUI 不重复显示 secret。
- 远程连接成功后无需重新启动 CLI 或第二个 TUI；状态行明确显示当前为远程目标。
- 撤销流程不要求用户输入 Key ID，撤销后新连接失败，旧连接按协议关闭或进入不可用状态。
- 现有独立 `answra remote ...` 命令和已有持久连接凭据仍可兼容使用。

## 风险

- 当前 `CodingSession` 与 TUI 主要按单一 host 组合；target 切换若没有明确的关闭、取消和事件收口，可能造成旧 host 事件写入新 target，必须用显式 target generation 丢弃迟到事件。
- Host 端的永久连接码等同远程控制凭据；面板复制和显示必须限制在首次创建结果，不能将 secret 写入 transcript、输入历史或普通日志。
- 两台 CLI 的网络连接可能因生产信令、NAT 或防火墙失败；面板必须显示稳定错误和重试入口，不得伪造“已连接”。
- 撤销和断开是不同操作：撤销影响后续授权，断开只结束当前 controller 会话；文案和测试必须明确区分。
- 独立命令与 slash 面板会在过渡期并存；两套入口必须共享同一用例和持久化端口，避免出现不同的有效性规则。

## 验证与防回退

提案实施后迁移到 `docs/notes/implemented/feature/`，并在 Note 中记录自动化测试与两台真实 Windows CLI 的生产信令验证结果。若 target 切换无法在同一 TUI 中保持取消、退出和错误语义，则不得用“打开第二个隐藏 TUI”替代，应收窄为先完成面板管理和明确的 attach 状态。
