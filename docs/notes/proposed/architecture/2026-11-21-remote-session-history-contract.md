# Note：远程会话历史列表契约

状态：提案

## 问题

桌面 IPC 和 `AgentService.listConversationSessions` 已能列出 conversation scope 的历史会话，但 `@answra/remote` 没有对应的远程命令。移动端 controller 连接 host 后只能创建或打开已知 conversation，无法发现 host 已有的会话。桌面 host 与 CLI host 的可用 scope 不同，协议不能把 scope 的选择权交给 controller，否则移动端可以请求未开放的模式。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/remote/commands.ts`、`capabilities.ts`、`packages/remote/src/host/hostPort.ts`、`remoteHostSession.ts`、`packages/remote/src/controller/remoteControllerSession.ts`、`packages/remote/src/testing/`
- UI/进程/协议/持久化表面：远程协议、host/controller 会话命令、桌面 host 后续适配
- 相关 Note：
  - [移动端远程 controller](../../proposed/architecture/2026-11-21-mobile-remote-controller-p2p.md)
  - [远程会话自动重连核心](../../implemented/architecture/2026-11-21-remote-session-reconnect-core.md)
  - [会话列表游标分页](../../implemented/architecture/2026-11-17-session-list-cursor-pagination.md)

## 提案

- 新增 `list-sessions` 命令，请求只带可选 `cursor` / `limit`，不携带 `scope`。
- Host 在 `HostCommandPort.listSessions` 中决定可见范围：桌面 host 固定返回 `conversation`，CLI host 后续固定返回 `coding`；不可见 scope 不返回、不能通过猜 conversationId 打开。
- 返回值复用 `ConversationSessionPage`，只含摘要，不含消息正文、工具输出或事件。
- `RemoteCapability` 增加 `sessions`；不支持历史的 host 不声明该能力，`RemoteHostSession` 对缺失端口返回稳定的 `invalid-command`。
- controller 暴露 `listSessions(query?)`；移动端只按 capability 显示入口。
- 分页继续沿用 `(updatedAt, conversationId)` keyset 游标；`REMOTE_SESSION_LIST_MAX_LIMIT` 限制单页上限为 200。
- 本阶段只补协议和共享测试，不实现桌面 host 适配，也不改 CLI remote host 的内存 runtime。

## 模块边界

- `packages/shared/src/schema/remote`：只定义命令、查询和 capability。
- `packages/remote`：只负责命令路由、端口和 controller 方法，不读 SQLite、不决定 scope。
- host 适配层负责 scope 过滤和分页；移动端不接收未开放 scope 的会话。
- `sessions` 能力与 `conversation`/`coding` 领域解耦；capacities 只描述入口，不改变业务帧语义。

## 曾考虑的替代方案

- **让 controller 传 `scope`：** 舍弃。会把“哪些模式可见”的决定权交给手机，桌面后续无法安全隐藏 interview/answer。
- **复用 `snapshot` 发现会话：** 舍弃。snapshot 需要已知 conversationId，无法列出历史。
- **新增独立 `session-list` 帧：** 舍弃。命令已有 `command-ok` 承载返回值，独立帧会增加第二套请求关联。
- **桌面直接返回所有 scope：** 舍弃。interview/answer 尚未纳入远程控制，暴露摘要也会扩大产品边界。

## 验收标准

- 可观察结果：controller 在声明 `sessions` 的 host 上能拿到摘要分页；不支持时收到 `invalid-command`。
- 自动化验证：`session.test.ts` 覆盖命令路由；codec 覆盖新命令；host 缺少 `listSessions` 时稳定失败。
- 需要的实机验证：桌面 host 适配完成后，用 CLI controller 和移动端分别验证分页、空列表、host 切换。

## 风险

- 桌面 adapter 如果直接转发全局事件，仍可能泄露非 conversation 事件；该过滤必须在 host 适配层实现。
- CLI remote host 当前使用独立内存 runtime，不能直接支持已有 coding 会话列表；需要后续注入共享 store/catalog。
- 分页游标由 host 生成，controller 不应解析或持久化其内部格式。
