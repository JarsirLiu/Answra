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
- 左右 Shift 的 keydown 和 keyup 都经过当前 IME owner 的输入队列。keyup 设置 Rime release bit；普通字符仍只按原路径处理 keydown。
- `luna_pinyin_simp` schema 显式将 `Shift_L`、`Shift_R` 配置为 `commit_code`，由 librime 的 `ascii_composer` 执行切换，不在 renderer 手动绕过 Rime 输入。若切换时仍有未选词的拼音组合，renderer 先清除该临时组合，再将 Shift 交给 Rime，避免把拼音码提交成草稿文本。
- 当前 hook 跟踪当前 lease 的 ASCII 模式：非组合状态按左右 Shift 时切换；ASCII 模式下普通字符、数字、标点和文本编辑由原生编辑器处理，Shift 仍发送给 Rime。中文模式下，未组合时未按 Shift 的数字直接提交到当前选区，不要求 Rime 显示候选 UI；组合过程中数字仍发送给 Rime 作为候选序号。小数点没有中文模式直通特例，输入小数前先切换 ASCII。lease 重新获取或焦点恢复时复位为中文，以匹配 helper 的 `ascii_mode=false` 恢复策略。
- 焦点恢复重新启用 helper 时仍回到中文模式，这是当前固定预编译 helper 的既有行为；本变更不承诺跨失焦保留 ASCII 模式。

## 影响表面

- 用户可见：在对话、回复及 `EmbeddedImeInput` 文本输入框中按左或右 Shift，Rime 在中文输入与英文 ASCII 模式间切换；ASCII 模式可直接输入和编辑英文、数字及标点，回到中文后继续使用候选输入。中文未组合时数字直接输入，候选组合期间数字仍用于选择候选。未选词的拼音在切换模式时清除，不会写入消息草稿。
- 平台：Windows 与 macOS 使用相同的 Shift 习惯，renderer 依据标准 `event.code` 将物理左右 Shift 映射到相应 Rime keysym。

## 曾考虑的替代方案

- **Shift 在组合中将 `commit_code` 写入聊天草稿：** 舍弃。运行日志确认这会把未选词的编码提交为真实文本，并意外启用发送按钮；改为先清除未提交组合，再由 Rime 切换模式。后果是切换模式时会丢弃当前未选词的拼音。
- **renderer 自行切换到普通文本输入：** 舍弃。会绕过 Rime，造成候选、组合和编辑器提交路径分叉。
- **macOS 使用 Control+Space、Windows 使用 Shift：** 舍弃为默认方案。macOS 的 Control+Space 常用于系统输入源切换，存在快捷键冲突；两平台统一使用 Rime 的 Shift 规则，平台差异由物理键码适配。
- **在当前变更中修改 helper 并直接编译：** 舍弃。仓库固定使用校验过的预编译 helper；更新 helper 必须发布新资源版本，不能让 dev/打包流程临时编译 native 代码。

## 后果与防回退

- Shift 按下时 renderer 同步更新当前 lease 的编辑模式，以便随后的字符进入正确输入路径；Rime 仍负责引擎模式切换。切换时先取消未提交组合，不能将拼音码写入聊天草稿。测试覆盖该顺序、ASCII 模式普通字符直通、中文未组合数字直插、组合中数字继续交给 Rime，以及焦点恢复重置为中文。小数点应在 ASCII 模式输入；不要将其添加为中文模式数字直通键，以免破坏 Rime 标点规则。
- 输入 owner 失焦并重新启用时 helper 会强制回到中文；跨焦点保留模式需要提升 helper 版本并在两个平台更新受校验的资源。
- 数字键的候选序号选择和非组合数字输入不由本变更改动。

## 验证

- 自动化：纯函数测试覆盖左右 Shift keysym 与 release/modifier mask；UI hook 测试覆盖空组合状态的 Shift down/up 按顺序发送。
- 门禁：记录本次运行的 `pnpm notes:check`、`pnpm verify` 结果。
- 实机：当前环境为 Windows；需在 Windows 11 与 macOS 各验证左右 Shift 切换、Shift+字母、组合中 Shift 提交、候选显示/隐藏及失焦恢复。自动化测试不替代原生 librime 行为实测。
