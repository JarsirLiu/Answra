# Note：安装版设置页丢失「模型」分组（凭据库读取失败被静默吞掉）

状态：已实施

## 问题

分发的 answer 安装包在「设置」页只有「常规」和「关于」，没有「模型来源 / 本地模型 / 云端订阅」，用户无法切换到本地模型。功能代码和发布清单都在包里（`localAvailable: true`），但界面整块不渲染。

## 根因

两个缺陷叠加：

1. **UI 把两个独立请求绑在一起并吞掉错误。** `SettingsPanel` 用 `Promise.all([getConversationConfig(), getConversationApiKey()])` 加载模型视图，末尾只有 `.catch(() => undefined)`。任一请求失败，`modelView` 保持 `null`，随后 `modelView?.localAvailable && …` 让整个「模型」分组不渲染，且没有任何提示。
2. **安装版读凭据库失败。** 打包主进程把 `@answra/credentials` 打进 asar 内的 CJS bundle，`createSystemEntry` 用 `await import("@napi-rs/keyring")` 解析裸说明符；Electron 的 ESM 解析在 asar 路径下不可靠，抛错后被包装成 `CredentialStoreUnavailableError: 系统凭据库不可用…`。同一个 exe 以 `ELECTRON_RUN_AS_NODE` 运行时 CJS `require` 与文件 URL 导入都正常，说明问题在 asar 内的 ESM 说明符解析，而不是 keychain 本身。

## 涉及范围

- `packages/ui/src/components/panels/SettingsPanel.tsx`：模型配置与 API Key 分开加载，失败降级为提示。
- `packages/ui/test/FloatingBarApp.settings.test.tsx`：新增“Key 读取失败仍渲染模型分组”回归用例。
- `packages/credentials/src/index.ts`：原生模块改为 CJS 优先加载（`typeof __filename === "string"` 时用 `createRequire`，ESM 宿主仍动态 import），并在错误消息里附带底层原因。
- 不涉及 IPC 契约、清单格式或模型路由策略。

## 修复

- `getConversationConfig()` 单独 `await`：成功即渲染「模型」分组；失败才写入 `modelError`（不再静默）。
- `getConversationApiKey()` 独立加载：失败只在分组内提示“无法读取已保存的 API Key，如需更换请重新填写”，不影响配置展示、来源切换和保存。
- 凭据库加载统一走 CJS 解析路径（桌面 asar 内 bundle），CLI（ESM bundle）保持动态 import；两条路径共用同一 `createRequire` 失败即 fail-closed 的语义，不回退明文。
- `CredentialStoreUnavailableError` 消息保留中文前缀并追加底层 message，便于下次诊断，不包含任何密钥内容。

## 决定

- 配置可见性与凭据可用性解耦：凭据失败只降级为字段提示，绝不改变界面结构。
- 原生 keychain 模块由 CJS 解析（桌面）或动态 import（CLI），两条宿主路径都以“打不开即 fail-closed”为唯一语义。
- 架构守护允许 `packages/credentials/src` 使用 `node:` 内置模块（它是 Node-only 库，与 `packages/config` 同类），renderer/preload 仍禁止。

## 影响表面

- 用户：安装版设置页恢复「模型」分组；凭据库仍不可用时也能看到并选择本地/云端，填写的 Key 保存时若失败会得到明确错误。
- 开发/CLI：行为不变；CLI 仍走 ESM 动态 import。
- 诊断：凭据库错误的文本包含底层原因，不再只是一句通用提示。

## 曾考虑的替代方案

- **只在渲染层忽略 Key 错误（不改 UI 结构）：** 最小改动，但 `modelView` 仍为 null，分组依旧不渲染；只是把问题藏得更深；舍弃。
- **Key 读取失败时重试或延迟加载：** 不解决根因，且每次打开设置都多一次失败 IPC；舍弃。
- **把 `@napi-rs/keyring` 打进主 bundle：** 原生 `.node` 不能内联，仍需要 asar 外解包；且会让打包输入混入二进制；舍弃。
- **在凭据层加内存/明文回退：** 违反 fail-closed 与“Key 不进共享配置”的既有约束；舍弃。
- **把设置页整块改成运行时 feature 开关控制：** 与本次缺陷无关，且 `localAvailable` 已由发布清单提供；舍弃。

## 后果与防回退

- 设置页不得再用单个 `Promise.all` 合并“配置”和“凭据”两个不同可用性等级的请求；凭据失败必须可降级。
- 不要把 `.catch(() => undefined)` 用在会决定界面结构的加载上；至少写入可见状态。
- 原生模块加载必须保留 CJS 优先分支；只在 ESM 宿主使用动态 import。已验证打包后 bundle 内出现 `typeof __filename=="string" ? createRequire(__filename)("…") : import("…")`。
- 错误包装要继续携带 `cause` 和底层 message；不要把 key 或端点写进错误文本。

## 验收标准

- 安装版打开设置即可看到「模型来源」与「本地模型 / 云端订阅」，无需登录。
- 凭据库不可用时仍能看到分组，并出现可读提示；保存 Key 失败时显示具体原因。
- UI 测试在 `getConversationApiKey` reject 时仍能找到「模型」标题与地址输入框。

## 验证

- `packages/ui/test/FloatingBarApp.settings.test.tsx`：新增用例断言 Key 读取失败时「模型」分组、地址回填与提示同时存在，且没有 `role="alert"`。
- `packages/credentials` 单测保持通过（fail-closed、单次创建、空值清理）。
- `pnpm --filter @answra/desktop build:electron -- --profile=answer` 通过，bundle 内原生模块加载为 CJS 优先。
- 待实机：安装新包后确认「模型」分组出现，云端订阅与本地模型可互相切换，本地 Key 可保存并重启后回填。

## 风险

- 若安装版仍报凭据库不可用，说明 asar 内 CJS 解析也被阻断（例如解包规则变化）；届时按错误文本里的底层 message 继续定位，不要再改 UI 兜底。
- “无法读取已保存的 Key”提示会一直显示直到用户保存或重开面板；这是有意的可见降级，不要改回静默。
