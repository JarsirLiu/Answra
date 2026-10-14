# Note：跨平台内置 Rime 输入法桥接

状态：已实施

## 问题

Answra 的隐身模式需要在应用内提供中文物理键盘输入，同时避免依赖操作系统独立的 IME 候选窗口。当前 renderer 使用浏览器文本输入和系统 IME；隐身输入保护会阻止文本输入，直接在 renderer 中加入拼音缓冲也不能提供完整的组合输入、候选选择和焦点行为。

## 涉及范围

- 代码/模块：`packages/shared` 的输入法契约、`apps/desktop/src/main` 的平台桥接、`apps/desktop/src/preload` 的类型化 API、`packages/ui` 的候选词 UI。
- UI/进程/协议/持久化表面：对话编辑器的预编辑文本、候选列表、翻页、选择和上屏；librime 原生二进制、Rime 配置和词库资源；隐身模式的键盘焦点和捕获保护。
- 相关 Note：`docs/notes/rejected/architecture/2026-10-13-stealth-virtual-keyboard-evaluation.md`、`docs/notes/proposed/architecture/2026-10-13-comprehensive-stealth-mode.md`。

## 提案

采用 `librime` 作为应用内输入法引擎，在 Answra 内实现候选词 UI，不复用 Weasel 或 Squirrel 的系统输入法前端。

输入链路为：

```text
物理键盘 -> renderer/editor -> preload -> main/native bridge -> librime
         <- preedit/candidates/change <- preload <- main/native bridge
```

`packages/shared` 定义 `ImeChannels`、`ImeState` 和按键/候选请求类型。main 侧按平台加载 librime：Windows 使用 MSVC x64 DLL，macOS 使用 universal dylib；二进制放在 ASAR 外并由运行时路径解析。renderer 不导入 Electron、Node 或原生模块，只通过 `DesktopBridge` 接收预编辑状态和提交文本。

第一阶段只支持 Answra 自己的文本编辑器，不注册为系统级 Windows TSF 或 macOS Input Source。普通模式和隐身模式都使用同一套引擎；隐身模式必须在确认键盘通道可用后才启用非激活窗口策略。

配置和资源采用简体 `luna_pinyin_simp` 方案：预置官方 `luna_pinyin` 拼音词典与 `essay` 常用词/语言模型，并叠加 Answra 项目补充词条；用户词典写入应用数据目录。Windows 和 macOS 安装包只携带各自平台的运行库，不交叉打包。

## 决定

采用官方预编译 librime 加独立原生 `answra-rime-host` helper。helper 使用随 librime 发布的 `rime_api.h`，通过 `rime_get_api()` 获取官方版本化函数表，负责 `RimeSetup`、`RimeInitialize`、session、`RimeProcessKey`、上下文和 commit 的完整生命周期。Electron main 只通过带序号的 stdin/stdout JSON 协议与 helper 通信；renderer 只消费已有的 `ImeState`。

helper 作为按平台准备好的预编译二进制随资源提供；`ime:prepare` 只校验并整理资源，不在 `pnpm dev`、`pnpm bootstrap` 或用户机器上调用 CMake。候选 UI、提交文本和编辑器状态由 renderer 控制；原生资源只由 main 启动 ASAR 外的 helper。

## 模块边界

- `packages/shared`：只放跨进程类型、频道和纯数据模型，不放 librime API。
- `apps/desktop/src/main/ime`：持有 librime session、资源路径、按键处理和状态快照；处理初始化失败和版本不匹配。
- `apps/desktop/src/preload`：只转发 `ime:enable`、`ime:key`、`ime:select`、`ime:reset` 和 `ime:change`。
- `packages/ui`：显示 preedit、候选词和选择态；提交文本仍由编辑器状态所有者负责。
- 原生实现优先使用独立 helper 或 N-API 模块，不能让 renderer 直接加载 `.dll`/`.dylib`。

## 体积验证证据

截至 2026-10-14，librime `1.17.0` 官方发布资产如下：

- macOS universal：`rime-...-macOS-universal.tar.bz2` 3,999,581 bytes；对应依赖包 3,197,132 bytes。
- Windows MSVC x64：`rime-...-Windows-msvc-x64.7z` 7,428,809 bytes；对应依赖包 3,622,532 bytes。
- Windows MinGW：`rime-...-Windows-mingw.tar.bz2` 2,050,543 bytes，目录包含 `librime.dll`、导入库、插件和部署工具。
- macOS 目录包含 `librime.dylib` 及 `predict`、`lua`、`octagram` 插件。
- `rime-luna-pinyin` Git tree 约 0.87 MB，`rime-essay` 约 5.62 MB，均远小于模型资源。

这些是开发/发布压缩包大小，不是最终裁剪后的运行时大小；它们已经证明引擎和基础依赖不构成数百 MB 的体积风险。最终安装包仍需在本项目的 electron-builder 配置中实测。

## 曾考虑的替代方案

- **直接嵌入 Weasel：** 舍弃。Weasel 是 Windows 系统输入法前端，不能提供 macOS 实现，也不适合嵌入 Electron 的 renderer；其 GPL-3.0 许可证会扩大复用约束。
- **直接嵌入 Squirrel：** 舍弃。Squirrel 是 macOS 系统输入法前端，必须遵循 Input Source 生命周期，不能作为跨平台应用内组件；其 GPL-3.0 许可证也不适合作为 Answra 的通用桥接层。
- **renderer 自绘拼音算法：** 舍弃。与已有拒绝 Note 一致，不能满足完整物理键盘组合、候选确认和平台焦点验收。
- **继续使用系统 IME：** 舍弃。系统候选窗口是独立捕获表面；helper 或 librime 缺失时普通模式和隐身模式都 fail-closed。
- **Node/koffi 直接映射 C 结构体：** 舍弃。它要求在 Node 中重建平台 ABI 的嵌套结构和指针数组，已经导致候选读取触发 Electron 进程退出；官方 C API 应在原生编译单元中调用。

## 影响表面

- 编辑器需要区分已提交文本、预编辑文本和候选状态，不能把 preedit 直接持久化或发送给模型。
- 输入法桥接不可用时，文本输入保持禁用，不能静默回退系统 IME。
- 用户词典和配置升级需要版本化，避免应用更新覆盖用户数据。

## 验收标准

- 可观察结果：Windows 11 x64 和 macOS arm64/x64 上，物理键盘输入 `nihao` 能显示预编辑文本、候选列表，按数字/空格确认后正确上屏；退格、左右移动、Esc、Enter、翻页均可用。
- 可观察结果：普通模式和隐身模式都使用 Answra 窗口内的候选 UI，系统 IME 候选窗口不出现。
- 自动化验证：shared channel 类型、main session 状态机、候选选择/翻页、初始化失败和资源路径解析有单元测试；UI 覆盖 preedit/candidate/commit 状态。
- 打包验证：Windows 与 macOS 的最终安装包分别测量 librime、依赖和词库增量；原生文件位于 ASAR 外且可加载。
- 实机验证：Windows 11 22631 + Electron 29.4.6，macOS 当前支持的 x64/arm64 版本；覆盖普通窗口、隐身窗口、窗口重建和会议软件共享屏幕/窗口。

## 风险

- librime 官方 release 提供的是引擎开发包，不是 Electron N-API 绑定；需要维护稳定的 C ABI/N-API 适配层。
- Windows 和 macOS 的非激活输入能力不同；librime 只处理输入转换，不解决系统级键盘捕获、权限和窗口焦点。
- 词库授权必须逐项检查；引擎 BSD-3-Clause 不代表所有方案和词库拥有相同许可证。
- 系统捕获软件对 `setContentProtection` 的遵守程度不同，隐身验收仍需要 Zoom/Teams 实机矩阵。

## 后果与防回退

缺少平台运行库或词库时，隐身模式必须继续阻止文本输入，不得启用系统 IME。不得把 librime DLL/dylib 放入 renderer 或重新引入 renderer 自绘拼音算法；资源路径和 `ime:prepare` 是打包前检查点。

## 验证

已通过 main/preload/renderer typecheck、Electron bundle、IME popup tests、Note 门禁和 diff whitespace 检查。Windows 11 开发启动日志确认 librime session 可用，修正 HWND 解码后 `ImmAssociateContextEx` 返回 `applied: true`。隐身模式下完整候选输入闭环仍需人工输入验证；macOS universal 实机和安装包体积验证待对应构建环境完成。

## 实施结果

- `apps/desktop/native/rime-host` 使用官方 `rime_api.h` 编译平台 helper；`apps/desktop/src/main/ime/rimeBridge.ts` 只管理 helper 进程和 JSON 请求，不解析任何 librime C 结构体。
- `apps/desktop/src/main/ime/imeIpc.ts` 注册来源校验后的 typed IPC；资源缺失或加载失败时隐身输入保持阻断。
- electron-builder 将 `resources/rime` 放到 ASAR 外；`ime:prepare` 校验平台运行库和共享词库目录。
- composer 通过 `onCommit` 将已提交文本写回 draft，候选 UI 保持 renderer 自绘并沿用现有输入表面主题。

## 输入问题修复

候选 UI 使用 Windows 横向候选条样式：预编辑拼音独立显示在候选条上方，候选项在同一行展示序号与文本，当前项使用主题强调色。左右控制发送 `ArrowLeft`/`ArrowRight`，上下控制发送 librime 标准 `PageUp`/`PageDown` keysym；候选选择和分页状态仍由原生引擎返回，UI 不自行推算页码或索引。保留横向滚动以适配窄窗口。

默认 schema 固定为 `luna_pinyin_simp`。主 translator 保持官方 `rime-luna-pinyin` 的 `luna_pinyin.dict.yaml` 和句子联想排序，并通过 schema patch 启用 `rime-essay` 的常用词数据；不创建或挂载项目自定义主词典。开发启动时从受版本控制的 `native/rime-data` 安装官方 schema patch；`ime:prepare` 在原生 helper 编译前复制相同配置。首次启动将 schema patch 安装到用户配置目录，仅在文件不存在时创建，保留用户后续编辑。

`luna_pinyin_simp` 的简体输出还依赖官方 librime `deps` 包中的 `share/opencc` 数据；缺少 `opencc/t2s.json` 时会退化为繁体候选并记录 `opencc config not found`。英文联想采用上游 `BlindingDark/rime-easy-en` 的 `easy_en` schema/dict，通过 schema patch 接入；关闭其造句模式，避免把未完成的中文拼音组合生成带 `☯` 标记的伪英文候选，不启用可选的 Lua 分词扩展。

Windows 仅解除顶层与 Chromium 子 HWND 的 IME context 不足以阻止系统组合文本进入 Electron。创建窗口和启用内置输入前，还需通过 `ImmDisableIME(0)` 禁用 Electron UI 线程的系统 IME，再执行窗口 context detach；两个步骤任一失败都必须阻止输入。内置 IME 输入框设为只读，按键通过 librime 转换，已提交文本由应用写入；其他编辑器继续被隐身 guard 阻止焦点。librime `RimeProcessKey` 使用 X11 keysym，不能传 Windows 虚拟键码；Backspace 对应 `0xff08`。没有预编辑内容时，Backspace 由应用从已上屏文本中删除；组合中交给 librime。若 librime 不可用，输入仍保持阻断，不回退系统 IME。

候选窗的预编辑串独立显示在工具栏上方，候选项和操作集中在单个 Windows 风格横向圆角栏中；选中候选使用浅底和主题色侧边标记。renderer 不输出逐键、逐状态或 composition 日志，保留主进程资源初始化与隔离失败日志。

候选项区域单独滚动，翻页和左右选择控件固定在候选条右侧，窄窗口下不得被候选项横向滚动带出可视区域。

编辑器焦点与内置 IME 是两个独立能力：textarea 始终可聚焦和编辑；IME 开关只控制 Rime 按键拦截、预编辑和候选 UI。IME 不可用或关闭时不启用系统 IME，普通文本编辑仍可用于隔离问题。

Electron 的 `getNativeWindowHandle()` 返回的是包含 HWND 数值的 Buffer，调用 Win32 API 前必须先按 `void *` 解码；直接传 Buffer 会把 Buffer 自身地址误当成 HWND，导致禁用调用失败并按安全策略阻断内置输入。

隐身 guard 在 librime 异步启用完成前会暂时拦截输入框焦点；输入框现在会记录点击并在返回 `enabled: true` 后自动恢复焦点。只有内置 session 已启用的 textarea 才允许接收键盘事件，系统 IME 仍不会回退。

回复条展开的多轮对话输入框也复用该 composer、librime session 和 conversation IPC；隐身模式下 session 不可用时该输入框保持禁用，不能退回系统输入法。

输入法 hook 覆盖普通模式和隐身模式，统一通过 librime 处理按键。textarea 在 librime 异步启用期间保持可聚焦但只读，避免 disabled 控件阻断激活焦点；session 无法启用时保持输入阻断。

textarea 仅在原生 session 成功、`imeEnable(true)` 返回 `enabled=true` 后接受按键。初始化失败时输入保持阻断，不得回退到系统 IME。

内置 IME 激活时，textarea 必须保持可聚焦但设为 `readOnly`：Chromium 的 `beforeinput`/`compositionstart.preventDefault()` 不能可靠阻止 Windows 原生 IME 向可编辑控件提交组合文本。物理按键仍通过 `keydown` 交给 Rime；IME 关闭时 textarea 恢复普通编辑。回归测试应同时确认激活态可聚焦且不可被普通文本 change 写入，关闭态仍可编辑。

系统 IME 在应用所有模式和所有文本控件中都禁止作为输入后端。基础样式对输入框、textarea 与 contenteditable 设置 `ime-mode: disabled`；renderer 在捕获阶段拒绝 `compositionstart` 和 `insertComposition*`，避免系统组合文本提交到编辑器。内置 Rime 不可用时不得允许系统组合事件回退；普通直接输入仍可用于诊断，但只接收非组合键盘输入。Windows 原生 HWND context 隔离继续作为平台层防线，不能以 renderer 防线取代。

Rime 启动必须通过官方 `deploy_schema` 部署当前 schema 后再创建 session；仅调用 `start_maintenance` 不保证新加入的 `luna_pinyin_simp` 生成 prism，表现为 session 看似启用但所有字母均 `handled=false`。helper 启动时必须记录部署失败，协议测试需验证 `n/i` 返回 `handled=true` 和非空 preedit。

已验证：官方头文件 helper 的 Windows C++ 语法检查、Electron main/preload/renderer typecheck、Note 门禁和 diff whitespace 检查。未启动 Electron；真实候选词/退格 UI 闭环、Windows helper 与 DLL 的实机协议测试和 macOS universal 构建仍需在具备对应官方运行库和 CMake 的构建机执行。

## 后续实施顺序

1. 放入官方 Windows/macOS librime 运行库和 `luna_pinyin`/`essay` 数据，执行 `pnpm --filter @answra/desktop ime:prepare`。
2. 在 Windows x64 与 macOS universal 构建机执行真实输入闭环和候选窗口验证。
3. 完成最终安装包体积、签名和 macOS notarization 验证。
