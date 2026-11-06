# Agent Core

本目录只放被多个 Agent 领域实际复用的进程内底座原语。

- `model/`：模型供应商与 AI SDK 的边界适配。负责把 SDK 流转换成仓库认可的稳定事件，并在可重放的 HTTP 请求边界执行自动重试。
- `run/`：进程内运行协调。负责登记 run、取消在途 run、等待完成和进程退出收尾。

这里不拥有 Conversation transcript、Execution 持久化状态、UI 展示状态或产品策略。新增能力应先在所属领域完成，出现第二个真实消费者后再提到这里。
