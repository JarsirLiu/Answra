# Note：内置 Rime Shift 中英文切换

状态：已实施

## 问题

内置 Rime 输入法必须与系统 Rime 前端使用相同的 Shift 语义。renderer 曾把 Shift keydown 改写为 `setInputMode`，并丢弃 keyup，导致 Rime schema 的原生按键处理、composition 变化与候选更新无法发生。每个 hook 还独立生成 `ui-1` 一类命令 ID，可能与同一 renderer 的其他输入目标冲突。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/src/ime/imeKeyRouter.ts`、`apps/desktop/src/main/ime/imeIpc.ts`、`apps/desktop/src/main/ime/rimeBridge.ts`、Rime schema patch。
- UI/进程/协议/持久化表面：编辑器键盘 down/up 事件经过 typed IPC 到 main，再由现有预编译 helper 转发到 librime。
- 相关 Note：[内置 Rime 输入法桥接](../architecture/2026-10-14-embedded-rime-ime.md)、[焦点恢复与候选窗预热](../bug-fix/2026-10-15-ime-focus-restoration-and-popup-warmup.md)。

## 根因

此前按键路由把 Shift 转成绝对模式设置，并吞掉 keyup，因而没有遵循 Rime 原生规则。使用当前 Windows x64 librime 1.17.0、本地 schema 和 helper v2 的隔离用户目录验证：Shift keydown 返回 `handled=false`、模式与 composition 不变；Shift keyup 返回 ASCII 模式，保留 preedit `ni` 并清空候选。该行为由引擎/schema 决定，应用必须按完整状态和 commit 结果更新编辑器与候选 UI，不能另外推断、提交或 reset。

## 决定

- 左右 Shift 使用物理 `event.code` 识别；keydown 与 keyup 都经 typed `processKey` 和 main session queue 传给 Rime，keyup 带 native release mask。
- renderer 不再发送 `setInputMode`，不假设 Shift 会保留、提交或取消 composition。main 只发布 Rime 返回的 mode、preedit、候选与可选 commit；editor adapter 按命令结果至多应用一次 commit。
- Rime/schema 决定活动 composition 下的切换语义。当前 Windows helper 测试观察到 ASCII 模式下 preedit 仍在、候选为空；候选窗按 snapshot 隐藏。不得把 mode 切换描述成英文候选选择。
- 中文模式未组合时，数字直接提交到当前选区；组合过程中数字仍发送给 Rime 作为候选序号。ASCII 模式下普通字符、数字、标点和文本编辑由编辑器处理。helper enable、窗口恢复和目标切换不得隐式重置模式。
- 新 helper 协议 v2 的二进制尚需按固定 release 流程发布；旧协议 v1 不提供权威模式，main 必须拒绝启动旧 helper，不能伪装兼容。跨失焦模式保持由 v2 helper 验证。

## 影响表面

- 用户可见：对话、回复及 `EmbeddedImeInput` 的 Shift 行为跟随 Rime schema 与引擎响应；ASCII mode 允许 editor native text 路径，中文未组合时数字直接输入，组合期间数字继续由 Rime 处理。
- 平台：Windows 与 macOS renderer 都转发左右 Shift 的物理 down/up 事件；各平台 native helper 及 schema 结果需分别实测，不以 Windows helper 测试替代 macOS 证据。

## 曾考虑的替代方案

- **在 renderer 强制设定 `ascii_mode`：** 舍弃。它绕开 Rime 对 Shift down/up 和活动 composition 的原生处理，无法与系统前端保持一致。
- **renderer 自行切换到普通文本输入：** 舍弃。会绕过 Rime，造成候选、组合和编辑器提交路径分叉。
- **macOS 使用 Control+Space、Windows 使用 Shift：** 舍弃为默认方案。macOS 的 Control+Space 常用于系统输入源切换，存在快捷键冲突；两平台统一使用 Rime 的 Shift 规则，平台差异由物理键码适配。
- **沿用 helper v1 并在 renderer 猜测模式：** 舍弃。v1 不回报 `ascii_mode`，无法区分模式命令是否成功；v2 必须经固定 tag 的 release workflow 生成预编译资源。

## 后果与防回退

- Shift 后的 mode、composition、候选和 commit 只在 main 收到 helper 权威响应后更新；不得由 renderer 推断。renderer 的每条命令使用全 renderer 唯一 ID；main 仅缓存相同 ID/相同 payload 的重试，同 ID 不同 payload 要拒绝。小数点应在 ASCII 模式输入；不要将其添加为中文模式数字直通键，以免破坏 Rime 标点规则。
- 应用窗口重新聚焦和输入目标切换不得隐式改变 Rime 模式。helper 协议 v2 及匹配预编译资源发布前，不能宣称新模式切换路径已可运行。
- 数字键的候选序号选择和非组合数字输入不由本变更改动。

## 验证

- 自动化：UI key router/hook 测试覆盖 Shift keydown/keyup 均走 `processKey`、模式只由引擎 snapshot 更新、快速连续事件顺序和多个输入目标共享状态；main IPC 测试覆盖相同 commandId 的幂等重试及不同 payload 冲突拒绝。UI 与 desktop 定向测试及全量 `pnpm verify` 通过。
- 原生验证：Windows x64 MSVC helper v2 在隔离临时用户目录实测通过；`ni` 组合后 Shift down 不改状态，Shift up 变 ASCII，保留 preedit `ni`、候选变空且没有 commit。Electron/Windows 系统 IME 隔离及 macOS helper 行为仍待实机验证。
