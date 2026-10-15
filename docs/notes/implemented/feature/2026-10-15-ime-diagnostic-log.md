# Note：IME 控制台诊断日志

状态：已实施

## 问题

Windows 上 IME 焦点与候选窗问题依赖操作时序，用户复制控制台输出容易漏掉关键前后事件，无法从单次日志确认首焦点、按键、候选窗口和 owner blur 的顺序。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeDiagnostics.ts`、`imeIpc.ts`、`imeCandidateWindowController.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`
- UI/进程/协议表面：Electron main process 汇总 IME lifecycle、renderer 焦点/按键路由和候选 UI 诊断，直接输出到启动终端；不写诊断文件。
- 相关 Note：[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)

## 决定

IME lease 获取/释放/暂停/焦点确认、窗口 focus/blur、租约获取/释放/暂停、组合开始/结束、Rime 未处理或带修饰键的按键、候选 UI 首次绘制/可见状态变化、候选窗 show/hide/有效位置变化及快捷键后的选择区摘要输出到 `pnpm dev` 启动终端。普通逐键输入和候选内容变化不逐条打印；候选 DOM 只在同一租约首次出现或可见性、尺寸、样式变化时记录。Ctrl+A、Backspace 和 Delete 另记录按键路由及按键后的选择区长度/范围，不记录编辑器正文。renderer 诊断使用类型化 IPC，main 校验发送窗口、目标 ID 和事件名，并只接受固定字段。IME 诊断不写入文件，也不额外打印文件路径。

为排查候选 UI 逻辑可见但屏幕未呈现的情况，候选 controller 额外按状态边沿记录锚点首次可用/失效，以及 owner 恢复焦点时的候选窗可见、置顶、屏幕矩形和当前焦点窗口；owner blur settle 记录最终选择保留还是挂起。锚点坐标只在首次可用时记录，不随每个字符的位置变化重复输出；这些信息用于区分 renderer 锚点生命周期与原生窗口前台/呈现状态，不代表能够查询系统最终合成像素。

诊断记录 IME 实际按键、Rime preedit、候选词/注释、已提交的 IME 文本，以及候选 renderer 的 DOM 文本、元素矩形、可见性样式。Ctrl+A、Backspace 和 Delete 额外记录按键路由及按键后的选择区位置/长度；不记录输入正文。候选原生窗口快照包含 HWND、屏幕矩形、可见/最小化/聚焦/置顶/可聚焦状态、owner 状态、进程前台状态、显示器工作区/DPI 和 Electron 报告的捕获保护状态。Electron 没有通用 API 查询窗口是否被其他原生窗口逐像素遮挡，因此这些字段不能单独证明显示器上的最终像素可见。候选 renderer 事件只接受来自候选窗口的消息；输入目标事件仍只接受应用 owner 窗口。不会记录 composer 已有草稿或其他非 IME 编辑内容。

## 影响表面

- 诊断只存在于当前 `pnpm dev` 主终端输出；关闭终端后不保留副本。锚点坐标和候选窗口矩形会出现在终端摘要中。
- 终端记录包含 IME 拼音、候选和已提交文本；复制分享前应检查这些内容。

## 曾考虑的替代方案

- **只记录按键码、长度和候选数量：** 舍弃。无法区分 Rime 是否产生了预期候选、候选是否经过 IPC 到达 renderer，或候选 DOM 是否真实生成；此次定位明确需要核对这些具体值。
- **将每个 renderer 事件原样转发并多行打印：** 舍弃。逐键对象日志不可读且过量；改为 main 进程单行格式化，并省略普通按键路由和状态转发等冗余事件。
- **记录所有按键路由和每次 React 候选重绘：** 舍弃。它们产生重复噪音；只保留快捷键/组合退格的路由，以及候选展示状态实际变化后的 DOM 快照。
- **renderer 直接追加文件或使用通用日志 IPC：** 舍弃。renderer 不应拥有文件系统权限，通用 IPC 会扩大可写入日志的数据面；IME 专用频道可校验 sender 并限制字段。

## 后果与防回退

- 诊断不持久化，关闭 `pnpm dev` 后即消失；IME 组合和候选会出现在终端输出中，普通 composer 草稿不会记录。
- renderer 诊断必须经过 `ImeChannels.Diagnostic` 的事件/字段白名单，并按候选窗口与 owner renderer 分别验证发送者。

## 验证

- 自动化：IME IPC 测试覆盖 renderer sender 校验和诊断字段记录；hook 测试覆盖 input mount、focus/acquire/key-routing、快捷键选择区摘要以及 Acquire pending 时快速按键按顺序排队；候选 renderer 测试覆盖状态接收、绘制去重与 DOM 观测；候选窗口 controller 测试覆盖原生快照字段、重复位置去重、锚点状态边沿、owner 恢复焦点摘要及 show/hide 摘要；诊断 formatter 测试覆盖单行候选输出和冗余事件抑制。
- 手动：启动桌面应用后，IME 生命周期、按键结果、候选 DOM 绘制与原生窗口状态应直接出现在启动终端。
