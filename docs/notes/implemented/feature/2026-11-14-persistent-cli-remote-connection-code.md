# Note：CLI 持久远程连接码

状态：已实施

## 问题

CLI 远程连接原先要求先用 `remote key create` 生成最多 30 天有效的访问密钥，再在另一台机器执行 `remote key set` 粘贴保存；host/controller 也必须离开编码 TUI 单独操作。用户期望在 TUI 内用 `/remote` 开启共享并生成连接码，其他设备输入该码即可连接，而且重启后仍长期有效。

## 涉及范围

- 代码/模块：`packages/remote/src/access/accessKey.ts`、`apps/cli/src/tui/commands/`、`apps/cli/src/cli/remoteSessionCommands.ts`、`apps/cli/src/remote/credentials/`
- UI/进程/协议/持久化表面：CLI TUI host 启停、持久 host key、controller 连接码输入及本地凭据保存；没有新增服务端 pairing API。
- 相关 Note：[远程控制 P2P 信令](../../proposed/architecture/2026-11-13-remote-control-p2p-signaling.md)、[CLI 一次性 OAuth 环回回调例外](../architecture/2026-11-14-cli-loopback-auth-callback.md)

## 影响表面

- `/remote` 在当前 coding TUI 中创建无自动过期的 host 连接码并启动 host；终端关闭时 host 停止，持久码可在下次启动后继续使用。
- `answra remote attach` 没有已保存 controller 凭据时安全提示输入连接码，验证握手成功后持久保存，以后可直接 attach。
- 连接码保持 256-bit 随机 secret；host 持久化 secret 哈希，用户可通过 `answra remote key revoke <keyId>` 主动失效。

## 决定

复用现有 room/keyId/secret handshake，不引入短数字配对码或新的后端状态。host key 文件允许 `expiresAt` 缺省表示只由主动 revoke 终止；既有 7/30 天 key 行为保留。host key 记录增加明确的 `connection-code` purpose，TUI 的 `/remote` 重启后据此复用同一个 room/key，而不是重发 secret；首次创建时显示连接码，CLI 退出时关闭 host 但不撤销 key。controller 首次 attach 时从隐藏输入读取连接码，只有握手成功后才保存到现有 protected credential 文件，后续 attach 读取本地凭据。

## 模块边界

- `packages/remote`：只扩展访问密钥有效期契约；无 `expiresAt` 表示永久有效，撤销仍优先于有效期判断。
- `apps/cli/src/remote`：实现本地 key 存储、P2P host/controller 和 WebRTC；连接码不是仅存于内存的唯一来源。
- `apps/cli/src/tui/commands`：调用注入的 host 端口并呈现结果；不 import `@answra/remote` 或实现网络状态机。
- `apps/cli/src/cli`：组合模型配置、host 生命周期与 controller 连接码读取。

## 曾考虑的替代方案

- **短数字码加服务器 pairing API：** 需要新增 AnswraSite/网关端点、轮询、速率限制和服务端持久化；现有高熵 P2P 凭据可完成首版，暂不采用。
- **连接码只放进程内存：** CLI 重启后失效，违背长期有效要求，舍弃。
- **永久存储但永不撤销：** 泄漏后无法止损，舍弃；保留 host key revoke。
- **继续默认 7 天过期：** 用户必须频繁重新分享连接码，与长期有效要求冲突，舍弃；旧显式期限 key 仍受支持。

## 后果与防回退

- 永久连接码等同远程 coding/shell 控制凭据，UI 只在创建时显示；controller 首次输入不回显；host 文件只存哈希。
- `/remote` 重复调用不会再次打印 secret；通过 `Key ID` 显示明确撤销命令。
- 退出 CLI 停止 host 但保留 code 记录；下次启用时可复用该持久 key，不必重新分享。
- host 文件通过明确的 `purpose: connection-code` 识别这条持久连接身份；不得从 label 文本推测 key 用途。
- `answra remote attach` 只在握手成功后持久化首次输入的连接码，错误码不会污染 controller 凭据文件。

## 验证

- `packages/remote`：37 个测试通过，覆盖永久有效、撤销失效与有效期冲突校验。
- CLI：45 个测试文件、272 个测试通过；包括 host 文件重载后仍有效、secret 不落盘、`/remote` 展示与 TUI 退出清理、首次 attach 隐藏输入。
- CLI 类型检查、Biome、Note 检查和架构检查通过。
- 真实两台 Windows CLI 经生产 AnswraSite 信令/WebRTC 的公网重连与撤销验证尚未执行；现有 fake/本地联调证据不能替代公网网络矩阵。
