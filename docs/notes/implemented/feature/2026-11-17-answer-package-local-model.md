# Note：答题安装包支持本地模型

状态：已实施

## 问题

答题模式以 `--profile=answer` 打包，设置页已经包含「模型」分组，但 `ModelRouter` 的 `localAvailable` 固定为 `!app.isPackaged`。打包后本地来源被折叠成云端，用户即使自建 OpenAI 兼容服务也无法在答题包里选择，只能登录云端订阅。这与“答题包更开放、可自带本地模型”的产品诉求冲突。

## 涉及范围

- `apps/desktop/src/main/index.ts`：按发布 Profile 计算 `localAvailable`。
- `apps/desktop/src/main/conversation/modelRouter.ts`：新增可用性判定并更新来源裁决注释。
- `apps/desktop/src/main/releaseProfile.d.ts`：声明构建期注入的 release manifest。
- `apps/desktop/test/modelRouter.test.ts`：覆盖 answer/full 与开发/打包组合。
- `packages/shared/src/channels/conversation.ts`、`packages/ui/src/components/panels/SettingsPanel.tsx`：同步来源可用性说明。
- 复用既有本地模型存储、keychain、IPC 与 Agent `auth: "local"` 链路，不新增端点或凭据格式。

## 决定

- 开发态继续允许本地来源。
- 打包 `answer` profile 允许本地来源：设置页显示「模型」分组，可填 OpenAI 兼容地址、模型 ID 和可选 API Key；答题请求走 `auth: "local"`，不要求登录，也不触发云端令牌刷新。
- 打包 `full` profile 保持 `localAvailable=false`：本地来源仍在视图与保存层折叠为云端，避免绕过订阅门禁。
- 判定集中在 `isLocalModelAvailable(isPackaged, features)`；功能位来自构建期注入的 `__ANSWRA_RELEASE_MANIFEST__`（`local-model`），不在运行时猜测 Profile 或目录名。

## 影响表面

- 用户：answer 安装包无需登录即可配置并使用本地模型；未配置时发送给出“请先在设置 → 模型中配置本地模型服务”。
- 设置页：answer 包出现「模型来源 / 本地模型 / 云端订阅」分组；full 包保持不渲染。
- 模型调用：answer 路由使用 `answerModel || model`，本地 API Key 只从 OS keychain 读取。
- 发布：`dist:win` / `dist:mac` 的 answer 包行为变化；full 包不变。

## 模块边界

- 可用性策略留在 desktop main 的 `ModelRouter`，不下沉到 `@answra/agent` 或 renderer；Agent 只消费 `auth: "local"` 端点。
- `@answra/shared` 只描述 `localAvailable` 字段与注释，不包含 Electron/打包判断。
- 设置页只根据 `localAvailable` 渲染，不自行推断安装包类型。
- 本地配置仍写共享 `Answra/config.json`，API Key 仍写 OS keychain；不新增明文凭据路径。

## 曾考虑的替代方案

- **所有打包版一律开放本地模型：** 最开放，但 full 包的订阅门禁会被绕过，影响商业与支持边界；舍弃。
- **只靠环境变量或命令行开关：** 不需要改 UI，但普通用户无法在安装包内发现和保存配置，也不能持久化；舍弃。
- **为本地模型新增独立 feature ID 或插件系统：** 当前只有一个二选一来源，新增目录/审计面过大；舍弃。
- **在 renderer 根据 `app.isPackaged` 或 Profile 判断：** 会把发布策略放进 UI，且 preload 不暴露该信息；舍弃。

## 后果与防回退

- answer 包的本地模型不经过登录与云端令牌；这是有意放开的能力，不要再在 `AgentService` 或 `createLocalFetch` 中补登录门禁。
- full 包必须继续 `localAvailable=false`；若未来要开放，需另立产品决策并更新本 Note 与[共享客户端模型配置](../architecture/2026-11-13-shared-client-model-config.md)。
- Profile 只能来自构建期 manifest；不要在运行时读取 `package.json` 或目录名推断，避免开发/打包行为分叉。
- 设置页仍只按 `localAvailable` 渲染；不要为 answer 包复制第二套模型表单。
- 本地端点校验（http(s)、禁止 URL 内嵌账号密码、模型 ID 必填）继续由 `validateModelSettings` 唯一负责。

## 验证

- `apps/desktop/test/modelRouter.test.ts` 覆盖：清单含 `local-model` 时允许、缺省时拒绝、开发态始终允许；既有本地/云端 resolve 与保存门禁测试保持通过。
- 命令：`pnpm --filter @answra/desktop test -- modelRouter`、`pnpm --filter @answra/desktop typecheck`。
- 待实机：构建 answer 安装包，确认设置页出现「模型」分组、保存后无需登录即可答题；full 安装包仍不显示该分组。

## 后续变更（2026-11-19）

「本地模型」已建模为功能位 `local-model`，`answer` Profile 包含、`full` 排除，可用性只读发布清单；本文中“新增独立 feature ID 舍弃”的判断已被 [发布 Profile 改为数据驱动](../architecture/2026-11-19-release-profile-data-driven.md) 取代。安装版曾因 UI 静默吞掉 Key 读取错误而整块隐藏「模型」分组，修复见 [安装版设置页丢失模型分组](../bug-fix/2026-11-19-settings-model-group-hidden-by-keychain.md)。
