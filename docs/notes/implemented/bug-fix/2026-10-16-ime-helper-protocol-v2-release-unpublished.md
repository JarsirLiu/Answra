# Note：helper 协议 v2 未发布导致 pnpm dev 回退系统输入法

状态：已实施

## 问题

Windows 开发机执行 `pnpm dev` 后，中文输入仍走系统默认输入法，内置 librime 的 preedit 与候选窗完全不出现。诊断日志显示 `renderer-input-focus` 后紧跟 `lease-released reason:"acquire-rejected"`，诊断为 `imeAvailable:true` 但引擎 `enabled:false`，即渲染器判定内置 IME 不可用后回退到原生编辑。

## 涉及范围

- 代码/模块：`apps/desktop/native/rime-host/main.cpp`、`apps/desktop/src/main/ime/rimeBridge.ts`、`apps/desktop/native/rime-resources.json`、`apps/desktop/scripts/prepare-rime.mjs`、`.github/workflows/rime-host-release.yml`。
- UI/进程/协议：main 进程 helper 启动握手协议（v1→v2）、渲染器内置 IME 可用性判定与回退路径。
- 相关 Note：`../process/2026-10-14-rime-resource-downloads.md`、`../architecture/2026-10-14-embedded-rime-ime.md`、`../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md`。

## 根因

同一个提交 `94ed56e` 引入了两处互不兼容、却缺少配套二进制的变更：

1. 在 `main.cpp` 启动握手输出里加入 `protocolVersion:2`（`main.cpp:241`），并让 `rimeBridge.ts:199-200` 强制要求 `result.protocolVersion === 2`，否则抛 `librime helper protocol v2 is required`。
2. 把 `rime-resources.json` 的 helper tag 从 `answra-rime-host-v1.0.0` 改成 `answra-rime-host-v2.0.0`，但从未推送该 tag，`.github/workflows/rime-host-release.yml`（push `answra-rime-host-v*` 触发）因此没有产出 v2 release。`git tag` 本地与 origin 都只有 `answra-rime-host-v1.0.0`。

磁盘上 10/14 落盘的 `apps/desktop/resources/rime/win32/answra-rime-host.exe` 仍是 v1.0.0 的协议 v1 二进制：直接运行握手输出 `0\t{"available":true}`，缺少 `protocolVersion` 字段。于是 `rimeBridge` 判定不可用，`ime:prepare` 则直接以 `helper release answra-rime-host-v2.0.0 is not available; publish the tagged helper release first` fail-closed 失败。渲染器永远拿不到可用引擎，只能回退系统输入法。

## 修复

- 保持 `rime-resources.json` 指向 `answra-rime-host-v2.0.0`：协议 v2 是当前 `rimeBridge` 与权威 mode/提交语义的硬要求，回退版本等于推翻代码契约。
- 同步文档：`README.md`、`apps/desktop/resources/rime/README.md` 与 process Note 中原先写死的 `answra-rime-host-v1.0.0` 改为清单当前固定值 `answra-rime-host-v2.0.0`，并显式写明“tag/release 必须先行发布，再改清单”。
- 开发机一次性解封：在 v2.0.0 release 正式发布前，用已安装的 VS2022 `cl.exe` 从 `main.cpp` 编译协议 v2 helper 覆盖被 Git 忽略的 `resources/rime/win32/answra-rime-host.exe`。`main.cpp` 仅在运行期 `LoadLibrary` librime，编译不需要 CMake，也不需要 librime 导入库；该步骤只是本地临时手段，不是仓库流程。

## 决定

协议升级必须与 helper release 交付作为一个原子变更：先发布携带新协议的新 tag release 并生成 `SHA256SUMS`，再更新 `rime-resources.json`。在 release 到位前，`ime:prepare` 与内置 IME 保持 fail-closed；不放宽握手校验、不低于 v1 兼容，也不把编译 helper 纳入 `pnpm dev`/bootstrap/打包流程。

## 曾考虑的替代方案

- **把 manifest tag 回退到已发布的 `answra-rime-host-v1.0.0`：** 舍弃。v1 helper 协议与当前 `rimeBridge` 的强制 v2 校验不兼容，只会让握手永久失败，并掩盖“协议已升级、需要新二进制”的真实状态。
- **让 `rimeBridge` 兼容 `protocolVersion:1`：** 舍弃。v2 承载权威 mode 与 commit 语义等当前契约，为旧二进制保留分支等于把已删除的兼容层重新引入，扩大渲染器与 native 的耦合面。
- **在 `pnpm dev` 或 bootstrap 阶段自动调用 CMake 编译 helper：** 舍弃。违反“预编译资源、开发机与打包机不编译 C++”的既有约定，并让开发机依赖平台编译工具链；helper 只由受控的发布 workflow 生成。

## 后果与防回退

- 在 `answra-rime-host-v2.0.0` release 发布前，任何全新 checkout 与 CI 执行 `ime:prepare` 都会 fail-closed 失败，这是预期行为；禁止为了让 prepare “通过”而降级 helper、放宽握手校验或改成静默回退系统输入法。
- 协议字段变更不得与 release 交付分离：先推送新 tag 并确认 release 与 `SHA256SUMS` 存在，再改 `rime-resources.json`；禁止先改清单、后补 release。
- 诊断内置 IME 失效时，先看握手输出是否含 `protocolVersion:2`。缺字段代表资源未就绪，不要再误判为渲染器、焦点或 lease 缺陷。
- 本地编译出的 helper 与 `resources/rime` 仍属 Git 忽略目录，不得因此暂存任何二进制。

## 验证

- 只读复现 v1 资源：运行 `resources/rime/win32/answra-rime-host.exe <librime.dll> <shared> <userdir> luna_pinyin_simp`，旧二进制握手输出 `0\t{"available":true}`，确认缺 `protocolVersion` 字段。
- 本地编译 v2 helper 后同一命令输出 `0\t{"protocolVersion":2,"available":true}`，确认协议字段恢复且 `available:true`。
- `pnpm --filter @answra/desktop ime:prepare` 复现 `helper release answra-rime-host-v2.0.0 is not available`，确认 fail-closed 路径生效。
- 已推送 tag `answra-rime-host-v2.0.0`，`.github/workflows/rime-host-release.yml` 产出 release（`answra-rime-host-win32.exe`、`answra-rime-host-darwin`、`SHA256SUMS`）；重跑 `ime:prepare` 下载官方 helper 成功（`verified and prepared win32 runtime, official schema data, and easy_en`），其握手同样输出 `0\t{"protocolVersion":2,"available":true}`，与本地编译版本一致。
- 待完成：macOS 环境完整打包加载与系统输入法隔离实机矩阵验证。
