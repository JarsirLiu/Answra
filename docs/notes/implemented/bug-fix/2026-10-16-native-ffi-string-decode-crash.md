# Note：前台窗口诊断的 FFI 字符串解码导致主进程硬崩溃

状态：已实施

## 问题

用户在内置输入法组字（候选条可见）时用系统截图工具截屏，关闭截图后 `pnpm dev` 直接退出，主进程日志在打印 `candidate-update-show` 的中途被截断，没有任何 JS 堆栈、没有 `main-window-blur`，最后只留下 `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] ... Exit status 1`。表现为"应用自己崩掉"，无法从日志判断原因。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/windowForeground.ts`（`describeForegroundWindow`）、`apps/desktop/src/main/mainWindowController.ts`（`main-window-blur` 日志）、`apps/desktop/src/main/ime/imeIpc.ts`（`owner-blur-settled` 日志）、`apps/desktop/test/windowForeground.test.ts`。
- UI/进程/协议/持久化表面：主进程 Win32 FFI（koffi + `user32.dll`）与主窗口失焦诊断；不涉及 IPC 协议、renderer、Rime 会话或持久化。
- 相关 Note：[Shift 切换英文后输入被锁死](../../implemented/bug-fix/2026-10-16-ime-shift-ascii-input-lockout.md)（同一批工作新增了该诊断）、[内置 Rime 输入法桥接](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)。

## 根因

`describeForegroundWindow()` 用 `koffi.decode(buffer, "str16")` 解码 `GetClassNameW` 写入的 UTF-16 缓冲区。对 JS `Buffer` 使用 `str16` 时，Koffi 不把缓冲区当作字符数据，而是把缓冲区**内容**当成字符串指针再解引用，指向非法地址后触发 Windows 访问冲突（`0xC0000005`）。

这类原生访问冲突不是 JS 异常：`try/catch` 拦不住，Node/Electron 直接把进程带走，stdout 缓冲区还没来得及 flush，所以日志被截断在行中间，且看不到任何错误信息。

触发路径是主窗口**任何**失焦，而不是截图本身：`main-window-blur`（`mainWindowController`）和 `owner-blur-settled`（`imeIpc`）都会把 `...describeForegroundWindow()` 放进日志参数里求值，参数求值先于日志打印，因此崩溃时连 `main-window-blur` 都不会出现。系统截图工具抢占前台正是最常见的失焦场景。

证据：

1. 用户提供的完整日志里 `main-window-shown` / `main-window-focus` 正常打印（它们调用 `isCurrentProcessForeground()`，同一批 FFI 但只用 `GetForegroundWindow` + `GetWindowThreadProcessId`），全程**没有** `main-window-blur`，说明崩溃发生在 blur 处理器的参数求值阶段；即唯一的新增调用 `describeForegroundWindow()`。
2. 独立 Node 探针在同一台机器上复现：`GetClassNameW` 写入真实类名后 `koffi.decode(buffer, "str16")` 退出码 `-1073741819`（`0xC0000005`）；改成 `koffi.decode(buffer, "char16_t", length)` 后正常输出 `Chrome_WidgetWin_1` 并退出码 0。

## 决定

前台窗口诊断继续保留进程 ID 与窗口类名，但所有跨 FFI 的字符串读取必须"限定类型 + 显式长度"，诊断代码不得再出现无边界的字符串解码。

## 修复

- `describeForegroundWindow()` 改为 `koffi.decode(buffer, "char16_t", length)`，长度取 `GetClassNameW` 的返回值（不含结尾 NUL），`length === 0` 时根本不解码；缓冲区固定 512 字节 / 256 字符，与 `nMaxCount` 对应。
- 保留 `try/catch`，但明确它只能兜住类型/参数错误，不承担拦截访问冲突的职责。
- 新增 `apps/desktop/test/windowForeground.test.ts`：mock `koffi`，把"无边界字符串解码"（`type !== "char16_t"` 或缺 `length`）定义成抛错，锁定修复后的调用形状，并覆盖 `length === 0` 与强制 win32/darwin 两条分支。

## 曾考虑的替代方案

- **删除类名诊断，只保留进程 ID：** 舍弃。类名是把"谁抢走了前台"定位到具体窗口类型的关键信息，本次故障正是靠"缺 `main-window-blur`"定位的；既然已有安全写法并可用探针验证，就没有理由砍掉诊断。
- **用 `str16` 但要先 `koffi.alloc` 稳定内存再解码：** 舍弃。需要自行管理内存生命周期，复杂度更高；`char16_t` + 返回长度在语义上完全等价且无需分配。
- **改用 Electron API 获取前台窗口：** 舍弃。Electron 只暴露本进程窗口（`BrowserWindow.getFocusedWindow()`），跨进程前台信息必须走 Win32。
- **把诊断日志整体降级/删除：** 舍弃。IME 焦点与 lease 排障高度依赖这些日志；本次问题的可见性恰恰来自新日志，只是实现有缺陷。

## 后果与防回退

- 原生崩溃的表现是"日志中途截断 + dev 退出且无堆栈"，不要再把它当成未捕获 JS 异常去追；排查顺序应是先看关键生命周期日志是否缺失，再用最小 Node 探针复现可疑 FFI 调用。
- 仓库内禁止 `koffi.decode(buffer, "<字符串类型>")` 形态的无边界解码；跨 FFI 读取字符串一律使用 `char16_t`/`char` + 显式长度（参见 `windowForeground.ts`）。
- 新增任何 Win32 FFI 调用，必须先用独立 Node 脚本在真实 `koffi` 上跑通（不依赖 Electron），再接入主进程；单元测试 mock 只能锁定调用形状，不能证明没有访问冲突。
- `describeForegroundWindow()` 的调用方（`mainWindowController`、`imeIpc`）不需要改动，仍按"参数求值可能失败"的既有假设保持可选字段。

## 验证

- 定向验证：`pnpm --filter @answra/desktop test` 26 个文件 / 135 项通过（新增 1 个文件 3 项）。
- 真机 FFI 探针（纯 Node，不启动 Electron）：

  ```js
  const handle = getForegroundWindow();
  const buffer = Buffer.alloc(512);
  const length = getClassNameW(handle, buffer, 256);
  const className = length > 0 ? koffi.decode(buffer, "char16_t", length) : undefined;
  // 输出 {"pid":38436,"length":18,"className":"Chrome_WidgetWin_1"}，退出码 0；
  // 同一探针把最后一行换成 koffi.decode(buffer, "str16") 时退出码 -1073741819。
  ```

- 全量验证：`pnpm verify` 通过，desktop 135 项、UI 158 项、app 7 项测试通过，Biome lint、Note 门禁、各包 typecheck 和 architecture check 均通过。
- 实机验证（用户，Windows 11）：`ANSWRA_IME_DEBUG=1` + `pnpm dev` 下组字中用系统截图工具截屏并关闭，以及直接切换到其他应用，应用均不再退出，`main-window-blur` / `owner-blur-settled` 正常打印。
