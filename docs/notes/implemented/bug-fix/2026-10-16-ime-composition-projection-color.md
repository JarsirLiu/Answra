# Note：输入法 composition 投影文字不可见

状态：已实施

## 问题

Rime 已返回 preedit 和候选，但 Chat/Reply 等受控输入框没有显示正在组合的拼音。用户只能看到候选窗，误以为输入内容消失。

## 涉及范围

- 代码/模块：`packages/ui/src/ime/adapters/ControlledTextCompositionMirror.tsx`、mirror 样式及受控文本输入组件。
- UI/进程/协议/持久化表面：renderer 内 textarea/input 的 composition 临时投影；不改变 Rime session、按键路由、候选状态或 draft。
- 相关 Note：[IME 权威会话与文本路由提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 根因

composition 活动时，编辑器样式将原生控件文字设为透明，避免 draft 与临时 preedit 重叠。mirror 初始化时读取同一控件的 computed `color`，取得的也是透明值，导致它绘制的 preedit 同样不可见；候选窗仍正常显示，因此症状表现为“候选有内容、输入框上方的拼音消失”。

## 决定

- composition 投影从控件显式保留的 `--ime-composition-text-color` 读取文字颜色；该颜色在隐藏原生文字之前由编辑器样式定义。
- 控件没有定义投影色时，mirror 才回退到 computed `color`。
- mirror 仍只呈现 Rime snapshot 中的 preedit，不写入 draft，也不推断输入模式或候选行为。

## 修复

- composition 活动时由控件样式保留 `--ime-composition-text-color`，供 mirror 绘制临时文本；控件自身的文字绘制仍透明，避免与投影内容重叠。
- mirror 优先读取保留色，未定义时回退到控件 computed `color`。

## 曾考虑的替代方案

- **让 textarea 原生文字继续可见：** 舍弃。draft 文本与临时 preedit 会同时绘制，选区替换时可能出现重影。
- **在 mirror 固定使用主题色：** 舍弃。通用 `EmbeddedImeInput` 可能有控件专属文字色，固定主题色会与编辑器文本不一致。

## 后果与防回退

- 隐藏原生控件文字时必须保留 mirror 可读取的 composition 前景色；不能让 mirror 直接复用透明的 computed text color。
- 该修复只恢复 preedit 的可见性，不代表 Shift/ASCII 切换、候选定位或系统 IME 隔离已通过平台实测。

## 验证

- 自动化：UI 测试验证控件 computed `color` 为透明时，composition mirror 仍使用控件保留的投影颜色。
- 原生验证：尚未完成 Windows/macOS 实机验收。
