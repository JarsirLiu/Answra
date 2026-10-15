# Note：内置 Rime Shift 中英文切换

状态：已实施

## 问题

内置 Rime 输入法支持 Shift 触发 `ascii_composer`，但切到 ASCII 模式后英文无法输入。输入框仍保持 `readOnly`，hook 也继续把字符送到 Rime；Rime 在 ASCII 模式会将普通字符标记为未处理，renderer 又已阻止浏览器默认输入，因此字符丢失。此前的按键接通只覆盖了 Rime 切换，没有覆盖 renderer 的 ASCII 编辑路径。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`、输入控件、`apps/desktop/src/main/ime/rimeBridge.ts`、Rime schema patch。
- UI/进程/协议/持久化表面：编辑器键盘 down/up 事件经过 typed IPC 到 main，再由现有预编译 helper 转发到 librime。
- 相关 Note：[内置 Rime 输入法桥接](../architecture/2026-10-14-embedded-rime-ime.md)、[焦点恢复与候选窗预热](../bug-fix/2026-10-15-ime-focus-restoration-and-popup-warmup.md)。

## 根因

输入 hook 原先只发送 keydown，空组合时拒绝非单字符键；Rime bridge 没有左右 Shift keysym。接通 Shift down/up 后，运行日志显示 Shift 将拼音码提交并清除候选，后续字母返回 `handled=false`。这正是 Rime ASCII 模式的直通行为，但只读编辑器拦截了这些字符，且没有暴露当前 hook 的输入模式。

## 决定

- Windows 和 macOS 统一使用单独的左或右 Shift 切换中英文，键位使用物理 `event.code` 识别，避免依赖键盘布局对应的字符。
- Shift 只发送目标模式命令，不作为 Rime 按键；keydown 切换一次，keyup 只消费事件。main helper 使用 `set_option/get_option("ascii_mode")`，返回实际模式，renderer 不先行翻转。
- 切换模式不依赖 composition 状态。helper 不 reset、不提交、不清除或改写未完成的拼音；模式结果同时返回原 composition 和候选状态。左右 Shift 与候选、文本编辑状态独立。
- 中文模式未组合时，数字直接提交到当前选区；组合过程中数字仍发送给 Rime 作为候选序号。ASCII 模式下普通字符、数字、标点和文本编辑由编辑器处理。helper enable、窗口恢复和目标切换不得隐式重置模式。
- 新 helper 协议 v2 的二进制尚需按固定 release 流程发布；旧协议 v1 不提供权威模式，main 必须拒绝启动旧 helper，不能伪装兼容。跨失焦模式保持由 v2 helper 验证。

## 影响表面

- 用户可见：在对话、回复及 `EmbeddedImeInput` 文本输入框中按左或右 Shift，Rime 在中文输入与英文 ASCII 模式间切换；ASCII 模式可直接输入和编辑英文、数字及标点，回到中文后继续使用候选输入。切换期间 composition 保持原样；中文未组合时数字直接输入，候选组合期间数字仍用于选择候选。
- 平台：Windows 与 macOS 使用相同的 Shift 习惯；renderer 将左右 Shift 映射为模式命令，不映射为 Rime keysym。

## 曾考虑的替代方案

- **让 Shift 作为 Rime 按键并由 schema 处理：** 舍弃。其行为与 composition、`commit_code` 绑定，可能提交或清除未选词拼音；模式命令直接设置 `ascii_mode`，不触碰编辑状态。
- **renderer 自行切换到普通文本输入：** 舍弃。会绕过 Rime，造成候选、组合和编辑器提交路径分叉。
- **macOS 使用 Control+Space、Windows 使用 Shift：** 舍弃为默认方案。macOS 的 Control+Space 常用于系统输入源切换，存在快捷键冲突；两平台统一使用 Rime 的 Shift 规则，平台差异由物理键码适配。
- **沿用 helper v1 并在 renderer 猜测模式：** 舍弃。v1 不回报 `ascii_mode`，无法区分模式命令是否成功；v2 必须经固定 tag 的 release workflow 生成预编译资源。

## 后果与防回退

- Shift 模式只在 main 收到 helper 权威响应或对应 revisioned snapshot 后更新；不得由 renderer 先行切换，也不得因模式键清理 composition。`useEmbeddedIme` 使用 typed `setInputMode` session command，并从 main snapshot 同步跨输入目标模式。小数点应在 ASCII 模式输入；不要将其添加为中文模式数字直通键，以免破坏 Rime 标点规则。
- 应用窗口重新聚焦和输入目标切换不得隐式改变 Rime 模式。helper 协议 v2 及匹配预编译资源发布前，不能宣称新模式切换路径已可运行。
- 数字键的候选序号选择和非组合数字输入不由本变更改动。

## 验证

- 自动化：UI hook 测试覆盖左右 Shift 只发一次模式命令、keyup 不发命令、模式由 main 响应更新，以及组合中的 preedit 保持不变；main IPC 测试覆盖 owner 校验与不调用 reset。
- 门禁：UI `useEmbeddedIme` 13 项测试、desktop `imeIpc` 9 项测试、全 workspace typecheck、Biome、`notes:check` 和 `git diff --check` 通过。
- 原生/实机：helper v2 源码增加版本握手、模式查询与设置；当前环境仍只有 helper v1，v2 release `answra-rime-host-v2.0.0` 尚无 SHA256SUMS（HTTP 404），所以 helper 编译、`ime:prepare` 和 Windows/macOS 实机切换均待该固定 release 生成后验证。不得将自动化 IPC 测试当作原生验证。
