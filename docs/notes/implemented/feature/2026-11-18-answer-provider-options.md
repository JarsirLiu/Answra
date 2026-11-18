# Note：答题本地扩展请求参数

状态：已实施

## 问题

图推等复杂题目的答题耗时与积分主要由 reasoning tokens 决定。`@ai-sdk/openai-compatible` 已支持 `reasoningEffort`，但 MiMo 等厂商真正用于限制思考/总输出的字段是 `thinking`、`max_completion_tokens`、`thinking_budget`、`enable_thinking` 之类的扩展参数，客户端此前没有任何入口把这些字段带进请求。

## 涉及范围

- 代码/模块：`packages/shared/src/channels/conversation.ts`、`packages/config/src/{contracts,store,providerOptions}.ts`、`apps/desktop/src/main/conversation/{modelSettings,modelRouter}.ts`、`apps/agent/src/core/model/{provider,modelTransport}.ts`。
- UI/进程/协议/持久化表面：共享 `Answra/config.json` 新增非 secret 字段 `answer.providerOptions`；不新增 IPC、不改网站能力目录、不改登录凭据结构。
- 相关 Note：[答题提示词收敛内部推理](2026-11-01-answer-prompt-concise-reasoning.md)、[答题安装包支持本地模型](2026-11-17-answer-package-local-model.md)。

## 决定

- 扩展参数只从本地共享配置读取，入口为 `answer.providerOptions`：

```json
{
  "answer": {
    "providerOptions": {
      "thinking": { "type": "enabled" },
      "max_completion_tokens": 12000
    }
  }
}
```

- 该字段与模型来源无关：云端端点与本地端点都会在解析时把它合并进 `answer` 端点；云端端点若未来自带同名字段，本地值优先。
- 只接受普通对象；空对象、数组、序列化后超过 4 KB 或无法序列化的值会被静默丢弃，不让整份 `config.json` 失效。
- 不进入渲染层设置表单；`ModelSettingsStore.save` 会保留已加载的 `answer.providerOptions`，避免用户在设置里切换模型时把它清掉。
- Agent 侧在 `streamModel` 组装请求时，把端点参数并入 `providerOptions.answra`。`@ai-sdk/openai-compatible` 只把 provider 注册名下的未知 key 原样写进请求体；写在 `openaiCompatible` 下的未知 key 会被 schema 丢弃。provider 名统一由 `MODEL_PROVIDER_NAME` 常量提供，避免两处漂移。
- 端点参数与 Agent 自身参数按浅合并处理，端点声明优先；不新增 `maxOutputTokens` 或其它翻译层。
- 服务端能力目录保持原样：不需要为了让客户端支持厂商参数而改网站。

## 影响表面

- 用户：编辑本机 `Answra/config.json` 后重启桌面端，答题请求即带上配置的厂商字段。
- 模型调用：这些字段按原样进入 `/chat/completions` 请求体；不支持的模型或严格校验的网关可能返回 400，必须只给确认支持的模型配置。
- 对话：只作用于 `answer`，`chat` 端点不受影响。
- 本地模型：同样生效，不需要额外设置。

## 模块边界

- `@answra/config` 只做形状、大小校验与持久化，不解释厂商语义。
- desktop 的 `ModelRouter` 只负责把本地配置合并进答题端点，不按模型名猜测能力。
- agent 只负责合并到正确的 provider key，不判断模型是否支持某字段。

## 曾考虑的替代方案

- **网站能力目录下发 `providerOptions`**：需要改服务端契约与发布节奏，且用户明确不希望为此改网站；舍弃。
- **在 `openaiCompatible` 下直接写厂商字段**：SDK 会把未知 key 过滤掉，等于没配；舍弃。
- **按模型名硬编码字段映射**：模型 ID 会变，且不同网关支持面不同；舍弃。
- **环境变量**：打包应用下设置成本高于编辑配置文件，且没有持久化；舍弃。

## 后果与防回退

- 配置示例：MiMo 使用 `{ "thinking": { "type": "enabled" }, "max_completion_tokens": 12000 }`；支持 `thinking_budget` 的网关使用 `{ "enable_thinking": true, "thinking_budget": 4096 }`。不要把两套字段混发给同一模型。
- `max_completion_tokens` 与 `max_tokens` 不要同时设置；当前实现不会自动翻译，只配其中一个。
- 该字段只能降低“客户端无法配置”的阻碍，不能保证模型缩短思考；实际效果取决于厂商。
- 当前 `executeRun` 仍未把 `finishReason: "length"` 判为失败。若 `max_completion_tokens` 被思考耗尽，截断结果仍可能显示为正常完成；这属于独立的终态修复，不应在本次改动里改热点文件。
- 不要在本文件中新增模型能力白名单；能力声明继续留在本地配置。

## 验证

- `pnpm --filter @answra/config test`：覆盖 `answer.providerOptions` 的写入/读取、非对象与超限丢弃。
- `pnpm --filter @answra/desktop test -- modelRouter modelSettings`：覆盖本地配置覆盖云端/本地答题端点、只作用于 answer、保存设置时保留字段。
- `pnpm --filter @answra/agent test -- executeRun`：覆盖端点 `providerOptions` 被写入请求体。
- 待实机：编辑 `%APPDATA%\Answra\config.json` 后重启，确认请求体带对应参数，并分别验证支持/不支持模型的实际响应。
