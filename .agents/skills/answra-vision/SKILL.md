---
name: answra-vision
description: Answra 产品方向与 Agent 底座的北极星速查。规划或评估新功能、新增能力域、设计工具/打断/存储等跨域能力、判断某需求该落在哪一层时使用，防止实现偏离产品总体方向。
---

# Answra 产品方向与 Agent 底座速查

本 skill 是入口索引；完整提案与决策记录见
`docs/notes/proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md`
（实施后于 implemented/ 跟进）。任何能力域决策都应回到对应 Note 确认最新状态。

## 产品定位

Windows 桌面屏幕 AI 助手：围绕"屏幕上看到的、正在听的、正在写的"提供实时辅助。

五条产品支柱（全部经悬浮导航统一交互表面呈现）：

1. **屏幕问答**（截图答题、读文件问答）——已上线
2. **实时语音辅助**（面试官语音 → 建议回复；候选人麦克风 → 上下文）——在途
3. **会议助理**（实时纪要、材料整理、辅助回复）——未来
4. **文档共创**（多轮对话改写 Word 简历等）——未来
5. **跨应用微功能**（快捷键补全等）——未来

支柱之间不共享业务上下文与 profile，只共享底座机制。

## 架构组织（apps/agent 内部）

```text
src/
  worker/        线协议 + 命令分发 + 各域投影（唯一跨进程边界）
  core/          跨领域底座：模型执行器、Run 生命周期、
                 工具注册表、agent loop
  conversation/  多轮对话 + 一次性答题（已有）
  interview/     采集→VAD→ASR→turn→可打断回答（在途，按 10-19 Note 分阶段）
  voice/ meeting/ inline/ document/   领域平级加入；voice 未来从 interview 提升
```

依赖铁律：`domains → core`；core 不导入领域；领域之间禁止互导（`voice` 例外但只暴露端口）。Agent 工具由 Agent 静态注册并在 Agent 进程执行；desktop 可注入获准上下文（如工作区根目录），不得代执行 Agent 工具。采集、键鼠、窗口、密钥等桌面平台能力留在 desktop。

## 新需求落位判断（改代码前先过一遍）

1. **属于已有领域的行为变化？** → 在该域内改，先查该域 Note 的边界与防回退条款。
2. **全新场景？** → 平级加领域目录 + 组合根 + 投影 + Note；问自己能否通过"新 profile + 新命令 + 新投影"接入，而不是改 core 或别的域。
3. **需要 AI 执行工具？** → Agent 静态注册 + profile 授权，工具实现在 Agent 进程执行。desktop 只注入上下文或凭据；renderer 永不注入。
4. **需要打断/取消？** → 统一用 Run 生命周期：runId + AbortController + 过期结果丢弃，不新造取消机制。
5. **高频媒体流？** → 沿用 bounded queue + credit 窗口的 ingress 模式与 PcmFrame 约定。
6. **需要新存储？** → 每域独立 store 端口；实现必须保持原子认领语义（见 answer-run-claim-race Note）。
7. **是个大功能？** → 先写 `proposed/` Note 走 answra-change 流程，再动代码。

## 防回退红线（一旦违反即偏离方向）

- 不引入 Pi、独立 Node sidecar 或通用插件/DI 框架（rejected 2026-10-11 Pi Note）。
- Agent loop 先用 AI SDK 多步循环，不自研；自研需实测断点证据并重新提案。
- 不用会话 ID 推断区分场景；每能力显式 profile + 命令类型（10-18）。
- 不让 `runtime.ts` 长成多领域万能 service；不把算法/产品分支写进 worker 投影（10-19）。
- 不做 renderer 可注入 prompt/工具的"灵活性"；不做绕过白名单的万能 RPC 通道。
- 工具生态未成形前不预支记忆压缩、多 agent 编排等未来复杂度。
