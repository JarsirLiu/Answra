# Agent Core

本目录只放被多个 Agent 领域实际复用的进程内底座原语。

- `model/`：模型供应商与 AI SDK 的边界适配。负责把 SDK 流转换成仓库认可的稳定事件，并在可重放的 HTTP 请求边界执行自动重试。
- `agent/`：静态 Agent 注册、模型路由、AI SDK 执行和唯一 AgentEventEnvelope 写入；通过按序等待的回调交给领域维护 transcript。
- `transcript/`：Conversation、Answer、Interview 共用的消息 transcript、活动 run 认领与恢复游标端口；当前只有进程内内存适配器，不保存 AgentEventEnvelope。
- `tool/`：跨领域工具契约、静态注册表与单次调用执行管理；通用文件与 shell 工具在 `tool/builtin/`，领域专属工具留在各自领域目录。执行器只产出结果，事件仍由 `agent/executeRun.ts` 统一写入。
- `run/`：进程内运行协调。负责登记 run、取消在途 run、等待完成和进程退出收尾。

这里不拥有领域产品策略、Execution 持久化状态或 UI 展示状态。新增共享能力应先在所属领域完成，出现第二个真实消费者后再提到这里。`tool/` 是按产品方向提前落位的例外：领域互导禁令要求通用工具不能留在单一领域，取舍见 `docs/notes/implemented/architecture/2026-11-09-agent-tool-system-foundation.md`；其余能力仍按第二消费者规则执行。
