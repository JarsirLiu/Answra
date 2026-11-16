# Note：把 WriteStdin 合并进 RunCommand

状态：已实施

## 问题

Shell 工具此前拆成 `RunCommand` 和 `WriteStdin` 两个模型可见工具：

- `RunCommand` 在 `yieldTimeMs` 到期后返回 `sessionId`；
- `WriteStdin` 接收 `sessionId`，等待同一个进程或写入 stdin。

用户指出：`RunCommand` 本身已经有会话模式，另一个名字相近的 `WriteStdin` 容易被误认为“写文件”，而且模型需要先理解两个工具的调用顺序。用户明确要求合并进 `RunCommand`，不保留第二个工具。

## 涉及范围

- `apps/agent/src/core/tool/builtin/shell/tools.ts`：`RunCommand` schema 增加 `sessionId`、`chars`，删除 `WriteStdin` 工具定义。
- `apps/agent/src/core/tool/toolNames.ts`：删除 `WRITE_STDIN_TOOL_NAME`。
- `apps/agent/src/core/tool/builtin/index.ts`：只注册 `RunCommand`。
- `apps/agent/src/coding/policy.ts`、`conversation/profiles/registry.ts`、`interview/rehearsal/profile.ts`：从授权列表移除 `workspace.write-stdin`。
- `packages/ui/src/tool-presentation/`、`packages/ui/src/components/tool-call/`：删除 `WriteStdin` presenter/renderer，`RunCommand` 展示续接会话。
- `apps/agent/test/core/tool/shell/shellTools.test.ts`、`builtinTools.test.ts`、coding/interview/pruning 测试：改用四项工具集，会话续接走 `RunCommand`。

## 模块边界

- `apps/agent/src/core/tool/builtin/shell/tools.ts`：唯一的 shell 模型工具定义，负责命令与会话两种输入模式。
- `apps/agent/src/core/tool/builtin/shell/sessions.ts`：内部会话管理器；`writeStdin` 只是实现细节，不再映射为工具名。
- `apps/agent/src/core/tool/builtin/index.ts`：只注册 `RunCommand`，不再注册 `workspace.write-stdin`。
- `packages/ui/src/tool-presentation/`、`packages/ui/src/components/tool-call/`：删除 `WriteStdin` 展示分支，续接会话由 `RunCommand` presenter 处理。
- 领域 profile 只声明 `workspace.run-command`，不感知内部会话续接字段。

## 决定

- 模型只看到 `RunCommand`，内部 ID 仍为 `workspace.run-command`。
- 启动新命令：提供 `command`，可选 `workdir`、`timeoutMs`、`yieldTimeMs`、`maxOutputLength`。
- 续接已有会话：提供 `sessionId`，不能同时提供 `command`、`workdir` 或 `timeoutMs`；可选 `chars` 写入 stdin，`yieldTimeMs` 控制等待，`maxOutputLength` 控制本次快照输出。
- `validateInput` 强制 `command` 与 `sessionId` 二选一；同时给出时报 `invalid-input`。
- 续接输出仍使用既有 `ShellSessionSnapshot`，包在 `RunCommandOutput` 的 `{ kind: "session", snapshot }` 中；模型可见文本仍是 JSON snapshot。
- `ShellSessionManager.writeStdin` 保留为内部方法；它不是模型工具，不再出现在工具目录、profile 或 UI 工具映射中。
- `RunCommand` 的 `dispose` 继续负责清理所有会话。

## 曾考虑的替代方案

- **保留两个工具：** 用户明确否决。模型要额外理解 `RunCommand` 返回 sessionId 后改调 `WriteStdin`，并且名称制造“写文件”误解。
- **让 RunCommand 用 `command` 字段为空来判断续接：** 舍弃。无法区分空命令和缺失命令；显式 `sessionId` 更清楚。
- **把 `writeStdin` 作为 RunCommand 的隐藏子命令：** 舍弃。仍然需要第二套 schema 或字符串解析，模型契约不清晰。
- **完全移除会话模式：** 舍弃。长命令、交互式命令和增量输出需要续接能力；用户只要求合并工具，不要求删除能力。

## 后果与防回退

- 模型可见 shell 工具从两个减少为一个；工具目录、profile 和 UI 映射同步收敛。
- `RunCommand` schema 变宽，但 `validateInput` 明确限制两种模式，避免字段混用。
- 防回退：
  - 不得重新注册 `workspace.write-stdin` 或 `WriteStdin` 模型工具；
  - 不得在 `sessionId` 模式接受 `command`、`workdir`、`timeoutMs`；
  - 不得在 `command` 模式接受 `chars`；
  - 续接仍必须返回增量 snapshot，不能把全量输出重复塞给模型；
  - 会话清理仍由 `RunCommand.dispose` 收口。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/shellTools.test.ts test/core/tool/builtinTools.test.ts test/coding/agent.test.ts test/coding/application.test.ts test/interview/agent.test.ts test/core/context/pruning/prune.test.ts`
- 覆盖：启动会话、用 `sessionId` 继续、`chars` 写入 stdin、未知 sessionId、command/sessionId 互斥、session 模式拒绝 workdir/timeoutMs、command 模式拒绝 chars。
- `pnpm --filter @answra/ui exec vitest run test/toolPresentation.test.ts test/toolCallRenderers.test.tsx`
