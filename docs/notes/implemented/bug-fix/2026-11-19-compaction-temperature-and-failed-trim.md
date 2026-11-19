# Note：修复压缩摘要的 temperature 拒绝与失败后的错误裁剪

状态：已实施

## 问题

CLI coding 会话在上下文约 210k 时压缩失败，终端依次出现：

```text
claude-haiku-5-5 does not support non-default temperature
Error compacting conversation
```

随后底部状态行从约 210k 掉到 `ctx 15.0k/216k`。用户因此判断“上下文清理机制坏了”。这里有三个需要分开的事实：

1. **摘要调用被 provider 拒绝**：压缩摘要走 `AgentRuntime.generateText()`，固定携带 `temperature: 0`；当前 chat 模型不接受非默认 temperature，摘要请求直接 400。自动压缩和手动 `/compact` 共用这条路径，所以两者都失败。
2. **失败后仍执行了“压缩后”裁剪**：手动压缩带 `forceCompact`，压缩失败后非压缩分支仍把 `trimContextRequest` 的目标设为 `postCompactTarget`，于是这次请求的估算被砍到约 15k，并作为 `contextUsage` 写回状态；摘要和检查点并不存在，下一次请求又会回到约 210k。
3. **210k 本身不是清理逻辑失职**：`context-usage-changed` 现在直接采用 provider 每个 step 的真实 usage；一次大文件读取或长命令输出就能把真实上下文从几千推到 210k。256k 窗口下 `inputLimit = compactAt = 216k`，本来就会贴到上限才触发摘要压缩。

普通旧工具结果清理只清 `Read` / `Grep` / `RunCommand` 的旧文本结果，并保护最近 5 个结果、最近 12 条消息；当前回合刚产生的大结果清不掉。因此摘要压缩是唯一能把 210k 拉回小上下文的手段，它失败后剩余机制无法替代。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/agent/runtime.ts`：内部文本任务入口，移除固定 temperature。
  - `apps/agent/src/core/model/modelTransport.ts`：`generateModelText` 是摘要调用的唯一传输层；同步收缩参数面。
  - `apps/agent/src/core/context/preparation.ts`：压缩失败/跳过/取消时的最终请求裁剪目标。
  - `apps/agent/src/core/context/compaction/compactor.ts`：失败熔断与状态，本次保持语义，仅作为诊断背景。
- UI/进程/协议/持久化表面：
  - 不改 `ContextUsage`、`ConversationSnapshot`、worker 命令或 IPC。
  - CLI 底部 `ctx` 与 `/status` 继续消费同一 `contextUsage`；修复后失败不会再出现虚假的 15k。
  - 不新增 shared schema、桌面设置或模型能力字段。
- 相关 Note：
  - [上下文压缩只保留摘要与当前用户回合](../../implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [Provider 上下文超限的单次恢复](../../implemented/architecture/2026-11-14-provider-overflow-reactive-compaction.md)
  - [CLI 上下文用量改为事件驱动实时刷新](../../implemented/bug-fix/2026-11-19-cli-context-usage-live-event.md)
  - [256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md)

## 根因

- `runtime.ts:92` 对摘要等内部文本任务硬编码 `temperature: 0`。`@ai-sdk/openai-compatible` 会把它写进请求体；模型或网关拒绝非默认 temperature 时，请求在生成前就失败，`ContextCompactor` 只能落 `failed`。
- `preparation.ts:206-211` 在 `compaction.status !== "compacted"` 时仍根据 `forceCompact` 把裁剪目标从 `inputLimit` 换成 `postCompactTarget`。没有摘要却按“压缩后”目标裁剪，既省不掉真实历史，又把错误状态下的 `usage` 写成一个小值。
- 失败后自动路径按 `trigger !== "manual"` 累计失败次数，3 次后熔断 5 分钟；期间跳过压缩，上下文继续贴上限。这是防止持续失败的保护，不是根因，但会把“压缩不可用”放大成“长期停在 210k”。

## 决定

### 1. 内部摘要只使用端点默认采样参数

- 从 `AgentRuntime.generateText()` 删除 `temperature: 0`，请求不再携带 temperature。
- 从 `generateModelText()` 删除 `temperature` 形参与透传；它目前只有摘要一个调用方，删除后“内部摘要不会发送 temperature”成为类型层事实，而不是运行期约定。
- 不按模型名分支，不新增 `supportsTemperature` 配置，不做错误字符串匹配后重试。
- 理由：摘要不要求确定性采样；provider 默认值是最兼容的基线。模型能力差异应由显式配置决策解决，而不是在内部调用点猜测。

### 2. 只有真正产生摘要时才使用 `postCompactTarget`

- `preparation.ts` 的非压缩分支统一改为：

  ```ts
  final = trimContextRequest(initial.request, budget);
  ```

  即目标退回默认 `inputLimit`。
- `postCompactTarget` 只保留在 `compaction.status === "compacted"` 的重建、二次清理和 trim 路径。
- `failed` / `skipped` / `aborted` 都只受输入硬上限约束；仍超过 `inputLimit` 时由 `trimContextRequest` 抛 `ContextLimitExceededError`，维持 fail-closed。
- 语义：没有摘要就没有“压缩后”状态；失败时展示真实占用，不制造已压缩的假象。

### 3. 保持预算、prune 和熔断不变

- `compactAt == inputLimit`、`pruneAt`、`postCompactTarget`、`summaryMaxTokens` 本次都不调整。
- 普通 prune 的白名单、保护条数和 `minPruneSaving` 不变。
- 3 次失败 / 5 分钟熔断保留；温度修复后它不再是常态路径。
- 明确不在本次改动：把摘要换到独立模型、降低压缩触发点、把 210k 的实时 usage 改回本地估算、在 UI 里隐藏失败。

## 修复

实施顺序：

1. 修改 `runtime.ts` 与 `modelTransport.ts`，删除内部摘要的 temperature 参数面。
2. 修改 `preparation.ts` 非压缩分支，去掉 `forceCompact` 对裁剪目标的影响。
3. 补测试：
   - `modelTransport.test.ts`：`generateModelText` 调用 AI SDK 时不带 `temperature`；传输 API 已移除该参数。
   - `preparation.test.ts`：手动 `compactNow()` 摘要抛错时返回 `failed`、不写检查点、`usage.usedTokens` 保持压缩前估算（使用 `postCompactTarget < inputLimit` 的预算构造用例）；仅有超过 `inputLimit` 时才硬裁剪。
   - `preparation.test.ts`：成功的手动压缩仍按 `postCompactTarget` 裁剪并写检查点（回归保护现有行为）。
4. 运行 Agent 定向测试、typecheck、Biome 和 `pnpm notes:check`；完整提交前运行 `pnpm verify`。

## 曾考虑的替代方案

- **保留 `temperature: 0`，捕获“不支持 temperature”错误后重试一次**：舍弃。需要匹配 provider 错误字符串，错误文案随网关变化；每次失败多一次真实请求，且仍可能在第二次被其他参数拒绝。不是稳定契约。
- **给端点增加 `supportsTemperature` 能力字段**：暂不采用。它会把一次内部摘要缺陷扩展成 shared schema、config、桌面设置和 CLI 配置的跨包变更；当前没有第二个需要固定采样参数的内部任务，先用“不发送”覆盖全部兼容端点。
- **继续在失败时裁剪到 `postCompactTarget`，只修正展示文案**：舍弃。裁剪目标本身表达的是“摘要已成功后的软目标”；失败时仍执行会误导 usage、掩盖摘要缺失，并让用户以为旧上下文已被安全收纳。
- **把压缩触发点提前到 `inputLimit` 以下**：暂不采用。它改变产品成本和压缩频率，属于独立决策；当前问题在没有摘要能力，而不是阈值高低。
- **摘要改用独立的小模型/专用路由**：暂不采用。现有端点配置只有 chat/answer 两条路由，新增摘要路由需要配置面与密钥面一起设计；本次先恢复现有 chat 路由可用性。

## 验收标准

- 可观察结果：
  - 配置一个拒绝非默认 temperature 的 chat 模型时，手动 `/compact` 能成功生成摘要并写入压缩边界，`ctx` 降到 `postCompactTarget` 附近；自动压缩在达到阈值时同样成功。
  - 摘要仍失败时，`ctx` 保持压缩前的真实估算，不再出现 15k 假象；终端显示 provider 返回的错误文本加 `Error compacting conversation`。
  - 普通模型（接受 temperature）的压缩行为和压缩后上下文大小与改动前一致。
- 自动化验证：
  - `modelTransport.test.ts`、`preparation.test.ts`、`runtime.test.ts`：32 项通过。
  - `pnpm --filter @answra/agent typecheck` 通过。
  - 本次 5 个相关文件的 Biome 检查通过。
- 需要的实机验证：
  - 用会拒绝 temperature 的真实端点跑一段工具密集会话，记录压缩前 `usedTokens`、压缩后 `usedTokens`、`contextCompaction.state` 和模型后续是否继续任务。
  - 手动让摘要失败一次，确认状态行保持压缩前数值且没有新增检查点。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/model/modelTransport.test.ts test/core/context/preparation.test.ts test/core/agent/runtime.test.ts`：3 个文件、32 项通过。
- `pnpm --filter @answra/agent typecheck`：通过。
- 本次 5 个相关代码和测试文件的 Biome 检查：通过。
- 尚未对真实 `claude-haiku-5-5` 端点做实机压缩验证。

## 后果与防回退

- `generateModelText` 的接口不再暴露 temperature 参数，内部摘要不能绕过类型约束重新携带固定采样值；其他内部文本任务若需要采样参数，必须先建立明确的模型能力契约。
- 只有摘要成功并建立 checkpoint 后，才使用 `postCompactTarget`。失败、跳过或取消时仍遵守 `inputLimit`，超限则由 `trimContextRequest` 显式失败。
- 本地自动化验证覆盖请求选项和失败裁剪行为；尚未连接用户的 `claude-haiku-5-5` 端点做实机压缩验收。

## 风险

- 摘要采样回到 provider 默认值，摘要措辞会比固定 temperature 更不稳定；摘要本来就不是确定性产物，接受该代价。
- 删除 `generateModelText` 的 temperature 参数后，若未来某个内部任务确实需要固定采样，必须重新做能力声明决策，不能临时在调用点硬编码。
- 压缩失败时 `ctx` 会继续显示接近上限的真实值，用户可能觉得“没有清理”；这是诚实状态，修复摘要能力后才会下降。
- 本次不解决“单个超大工具结果把上下文瞬间推到 210k”；如果摘要再次不可用，自动路径仍会依赖硬上限 trim，可能丢弃最旧轮次。需要更早压缩或限制单次工具输出时应另开决策。
- 如果失败发生在 provider 超限恢复路径，`recoverRequest` 仍返回 `undefined`，该 run 按原始超限错误结束；本次不改变单次恢复契约。
