# Note：IME 候选条使用独立原生窗口

状态：已实施

## 问题

候选条此前在输入框 renderer 通过 portal 绘制。它虽脱离 DOM 面板裁剪，仍受源 BrowserWindow 视口限制；候选内容长时会被对话窗口宽度截断，不能像系统输入法一样独立显示。

## 涉及范围

- 代码/模块：`packages/shared` IME 候选 IPC 契约；`packages/ui` 候选条、输入 hook 和输入框锚点上报；`apps/desktop` 原生候选窗口 controller、IPC、屏幕坐标布局。
- UI/进程/协议/持久化表面：主窗口或回复窗口 renderer、主进程、候选 renderer、原生窗口和显示器工作区。
- 相关 Note：[候选词窗口复刻微软拼音 UI 与 preedit 入框](./2026-10-14-ime-candidate-popup-windows-style.md)、[候选词窗口升级为全局光标浮层（已归档）](../../archived/feature/2026-10-14-ime-candidate-overlay-portal.md)。

## 影响表面

- 用户可见：候选条由独立透明置顶 BrowserWindow 显示，宽度按候选内容测量，最大 640 CSS px，不受对话或回复窗口宽度限制；按输入位置选择显示器，并限制在该显示器 work area 内，空间不足时翻到输入位置上方。
- 候选条左边缘对齐当前 Rime preedit 的起点，避免拼音输入越长候选条越向右漂移；上一页/下一页控件在禁用时仍保持清晰可辨。
- 输入交互：候选窗口不激活、不接管键盘焦点；鼠标选词/翻页动作转发给拥有输入框的 renderer，仍由原输入 hook 调用 Rime 并处理 `committedText`。
- 平台：坐标使用 Electron 屏幕 DIP；renderer viewport CSS 坐标与无缩放 BrowserWindow bounds 相加得到屏幕位置。窗口沿用隐身捕获保护状态。

## 决定

1. 主进程 `imeCandidateWindowController` 独占原生候选窗口生命周期、owner、屏幕定位、窗口尺寸和捕获保护。主窗口或回复窗口只能经校验后的 IPC 上报当前 `ImeState` 与 textarea caret viewport 坐标。
2. 候选 renderer 只渲染共享候选 UI并上报自身内容尺寸。主进程使用 owner BrowserWindow content bounds 转换为屏幕 DIP，选择输入位置所在显示器，再用纯函数将窗口尺寸和位置限制到 work area。owner move/resize 及 display metrics/add/remove 事件会重新定位。
3. 窗口设为 `focusable: false`、`showInactive()` 和 always-on-top；Windows 额外应用仓库已有 non-activating window policy。IME 键盘事件仍留在原输入 renderer。
4. 候选窗口只有在页面加载完成、renderer 已安装 IPC 监听并发出 Ready 后才推送状态和显示。主进程兼容两个就绪事件任意先后，避免 renderer 尚未订阅时发送状态或显示空窗口。
5. 候选 renderer 只能发送有限的 `select`/`navigate` 动作。主进程转发给当前 owner；owner hook 负责调用 Rime 并在结果包含 `committedText` 时提交给草稿，候选窗口不直接调用引擎。
6. 输入失焦、引擎禁用/无候选和 owner 关闭时隐藏候选窗口；隐身状态改变时同步更新候选窗口捕获保护。

## 曾考虑的替代方案

- **继续用 renderer portal 并扩大 CSS 宽度：** portal 只能离开 DOM 裁剪，不能超出源 BrowserWindow 的视口，因此无法解决用户看到的宽度限制。
- **候选窗口直接调用 Rime 选词：** 会绕过 owner hook 的 `onCommit`，选词结果可能不进入草稿；因此窗口只转发用户动作。
- **将整套输入法状态迁入主进程并广播：** 会把草稿提交责任和 UI 生命周期搬出输入 renderer；现有输入 hook 已正确拥有提交回调，因此保留 hook 为 owner 更清晰。

## 后果与防回退

- 跨进程契约集中在 `ImeCandidateChannels` 与 `DesktopBridge`；输入 renderer 不能设置任意窗口边界，候选 renderer 不能向其他窗口发送通用 IPC。
- 独立候选窗口的点击必须保持非激活，并将动作路由回 owner；不能让候选 renderer 直接接管 Rime，否则可能丢失 `committedText`。
- 当前坐标换算假设页面 zoom 为 100%；若引入 BrowserWindow 页面缩放，须把 zoom factor 加入坐标转换及测试。
- 自动化测试覆盖 IPC 来源校验、owner 操作路由、候选尺寸/边界/垂直翻转，以及提交文本回写。自动化测试无法证明系统焦点和多显示器 DPI 行为；这些仍需 Windows 实机验收。

## 验证

- `pnpm verify`：Biome 检查 196 个文件通过；Note 门禁、全包 typecheck、架构检查通过；Vitest 共 200 项通过（app 7、ui 104、desktop 89）。
- `pnpm --filter @answra/desktop build`：Electron main/preload 与 Vite renderer 生产构建通过。构建输出包含既有 `::global` CSS 解析、chunk 体积和 ineffective dynamic import 警告；未发现候选窗相关构建错误。
- 候选窗口 controller 测试覆盖页面加载与 renderer Ready 两种先后顺序；renderer 未就绪时保持隐藏，就绪后送状态并显示。
- 主进程记录候选 renderer 加载失败、窗口显示、隐藏请求原因及隐藏前可见状态，便于区分加载问题、没有候选状态和原生窗口显示问题。
- `[ime] key result` 只记录按键 code、处理结果、preedit 长度和候选数量，不记录输入内容，用于定位键盘事件与 Rime 状态之间的故障。
- 使用临时 user data 目录直接驱动 Windows `answra-rime-host` 和 `luna_pinyin_simp`：`n`、`i` 分别返回 preedit 和“你、拟、尼”等候选；证明随仓库提供的 helper/schema 本身可输出中文，不替代 Electron 输入链路实测。
- `git diff --check`：通过。
- 2026-10-14 用户反馈候选条未按输入串左侧对齐且分页控件不明显；修复后由 UI 测试锁定 preedit 起点锚定和分页控件状态/可访问名称。
- 尚未完成 Windows 原生窗口人工验收：点击候选期间焦点是否保留、Rime 提交是否回到原输入框，以及 100%/150% DPI 和跨显示器移动。自动化布局测试覆盖负屏幕坐标、工作区边缘与垂直翻转，但不能替代操作系统级验收。当前会话没有可操作的原生桌面 UI 通道，因此这些行为不能据自动化结果宣称已验收。
