# Note：发布 Profile 改为数据驱动

状态：已实施

## 问题

发布裁切原先有两层写死的知识：

- `release-profile.mjs` 用 `new Set(["answer", "full"])` 固定 Profile 集合，`ReleaseProfile` 是封闭联合；新增版本（例如面向个人开发者的技术版）必须改构建代码。
- 功能到构建产物的映射分散在多个脚本：`build-electron.mjs` 手写 define 列表、用 `features.includes("interview") ? … : …` 选入口；`write-electron-builder-config.mjs` 用 `profile === "answer"` 分支决定资源与解包项。
- “本地模型”没有建模成功能位，而是 `isLocalModelAvailable(isPackaged, profile)` 里的名字判断，导致“这个版本是否允许本地模型”无法像 answer/chat 一样在配置里控制。

结果是：每加一个发行版本都要改三四个脚本，且容易出现“配置里写了但构建没接上”的静默偏差。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/release.ts`、`release-features.json`：功能目录新增 `local-model`，`ReleaseProfile` 改为开放字符串，清单 `schemaVersion` 升到 2。
  - `apps/desktop/release-features.mjs`（新增）+ `.d.mts`：构建期功能表、define 名生成、入口规则、额外构建目标、禁止可达模块。
  - `apps/desktop/release-profiles.json`：升 `schemaVersion: 2`，Profile 放进 `profiles`，新增显式 `builder` 覆盖块。
  - `apps/desktop/scripts/release-profile.mjs`：解析/校验 v2 配置，返回 `{ manifest, builder }`。
  - `apps/desktop/scripts/electron-builder-config.mjs`（新增）：把 `builder` 覆盖块应用到 electron-builder 配置。
  - `apps/desktop/scripts/build-electron.mjs`、`audit-packaged-input.mjs`、`write-electron-builder-config.mjs`、`vite-release-config.ts`、`vite.config.ts`：改读功能表，不再按 Profile 名分支。
  - `apps/desktop/scripts/check-release-parity.mjs`（新增）：`pnpm profiles:check`。
  - `apps/desktop/vitest.config.ts`、`packages/ui/vitest.config.ts`：测试 define 从共享目录生成。
- UI/进程/持久化表面：无运行时行为变化；安装包清单 `profile/features` 的 `schemaVersion` 为 2。
- 相关 Note：[安装包功能裁切与发布 Profile](2026-11-01-answer-only-release-profile.md)、[答题安装包支持本地模型](../feature/2026-11-17-answer-package-local-model.md)。

## 决定

- **Profile 集合开放**：合法 Profile = `release-profiles.json` 中 `profiles` 的键；名称必须匹配 `^[a-z][a-z0-9-]*$`。每个 Profile 仍必须对功能目录中每一项显式 `include` 或 `exclude`，清单不能为空且必须包含 `answer`。
- **功能表唯一来源**：`release-features.mjs` 声明每个功能的 `gate`（`define` / `manifest` / `core` / `declared`）、禁止可达模块；define 名由 `featureDefineName()` 生成（`local-model` → `__ANSWRA_FEATURE_LOCAL_MODEL__`）。
- **入口按规则选择**：`ENTRY_RULES` 用「首个命中的 `when` 功能」决定 preload 与 agent worker 入口；`EXTRA_TARGETS` 声明随功能追加的构建目标（当前为 `chat` → grep worker）。脚本里不再出现 `features.includes("interview") ? …` 或 `profile === "answer"`。
- **打包覆盖写进配置**：`profiles.<id>.builder` 支持 `appId`、`productName`、`output`、`nsisArtifactName`、`extraResources`（替换）、`extraResourcesAppend`（追加）、`asarUnpack`（替换）、`filesExclude`（追加 `!pattern`）。未知键直接失败，防止拼写错误静默失效。
- **本地模型改为功能位**：`answer` Profile 包含 `local-model`，`full` 排除；`isLocalModelAvailable(isPackaged, features)` 只读清单功能位，不看 Profile 名字。
- **新增规范化门禁**：`pnpm profiles:check` 校验目录与功能表一致、每个 Profile 可解析、入口文件存在、`define`/`manifest` 门禁在源码中被引用、没有游离 define 字面量、未包含 `interview` 的版本不得带入 ASR/sherpa 资源。

新增一个发行版本（例如技术版）只需在 `release-profiles.json` 增加一项，例如：

```json
"tech": {
  "include": ["answer", "chat", "workspace", "settings", "account", "announcements", "updates", "stealth", "local-model"],
  "exclude": ["interview"],
  "builder": {
    "appId": "dev.answra.desktop.tech",
    "productName": "Answra Tech",
    "output": "release/tech",
    "extraResources": [],
    "asarUnpack": ["**/node_modules/@napi-rs/keyring*/**"],
    "filesExclude": ["**/node_modules/sherpa-onnx-node/**", "**/node_modules/sherpa-onnx-*/**"]
  }
}
```

再按该 ID 运行 `build:electron`/`vite build --mode tech` 与 `write-electron-builder-config.mjs --profile=tech`，无需改脚本。

## 模块边界

- 运行时只依赖 `packages/shared/src/release-features.json` 与构建期注入的 manifest；构建期表 `release-features.mjs` 仅被 `apps/desktop/scripts`、`vite.config.ts`、`vitest.config.ts` 读取，不进入 renderer/main 运行时。
- Profile 策略（有哪些版本、带哪些资源）留在 `release-profiles.json`；功能语义（define、入口、禁止模块）留在 `release-features.mjs`；两者分层，避免一个文件同时承担产品与打包细节。
- electron-builder 覆盖的应用逻辑集中在 `electron-builder-config.mjs`，脚本与 `profiles:check` 共用，防止门禁和真实打包用两套规则。

## 曾考虑的替代方案

- **保留闭合并列联合，只把 answer 改成参数：** 改动最小，但“新增版本不改代码”无法成立；舍弃。
- **把构建字段一起放进 `packages/shared/src/release-features.json`：** 单一文件更直观，但会把 esbuild 入口、资源解包等打包知识塞进运行时包，renderer 也会间接携带；舍弃。
- **为每个功能写一个注册文件/插件：** 扩展性最好，但当前只有 10 项功能、两类入口规则，文件和间接层成本高于收益；舍弃。
- **只做配置校验、不做门禁扫描：** 配置能过，但“功能声明了却没有门禁”这类问题仍会静默存在；舍弃，保留 `profiles:check` 的源码扫描。
- **手工维护 electron-builder 配置：** 容易与功能清单漂移；舍弃。

## 后果与防回退

- 新增发行版本只改 `release-profiles.json`；如果发现还要改构建脚本，说明功能表缺少对应能力，应补功能表而不是加名字分支。
- `settings`、`account`、`announcements`、`updates`、`stealth` 目前在清单中登记但**没有**运行时门禁（`gate: "declared"`）；`profiles:check` 会打印提示。接门禁时把对应项改成 `define` 或 `manifest`，并让检查通过。
- 每个 Profile 仍必须包含 `answer` 核心能力；若未来出现不含答题的版本，必须先修改这一产品约束和本 Note，而不是绕过校验。
- `ReleaseManifest.schemaVersion` 升到 2；任何读取清单的脚本都必须同步校验版本，不要再接受 1。
- 不得在脚本里恢复按 Profile 名或按功能名的三元分支；入口变化写进 `ENTRY_RULES`/`EXTRA_TARGETS`。

## 验收标准

- 只改 `release-profiles.json` 能新增 Profile，并生成对应 manifest、define 与 electron-builder 配置。
- `answer` 构建产物的功能清单与升级前一致，仅多出 `local-model`；审计仍通过。
- `pnpm verify` 在目录/功能表不一致、Profile 漏项、define 未被引用、`interview` 缺失却带入 ASR 资源时失败。

## 验证

- `apps/desktop/test/releaseProfile.test.ts`：answer/full 清单、确定性顺序、非法 Profile、目录同步、builder 覆盖、`readViteReleaseConfig` 与 v2 配置一致。
- `pnpm --filter @answra/desktop profiles:check`：2 个 Profile、10 项功能通过，并提示 5 项 `declared` 技术债。
- `pnpm --filter @answra/desktop build:answer` 与 `audit:packaged -- --profile=answer` 在本变更上通过；`out/release-manifest.json` 为 `schemaVersion: 2` 且含 `local-model`。

## 风险

- 功能表的 `forbiddenModules` 是路径字符串，重命名目录后必须同步，否则审计会放过已排除模块；`profiles:check` 目前只校验入口存在，不校验禁止路径是否存在。
- `builder` 覆盖是“整块替换”语义；新增 Profile 若只写 `extraResourcesAppend` 会继承基础 `extraResources`（含 vad 资源），需要显式清空时写 `extraResources: []`。
- 开放 Profile 后，拼错 Profile 名只会得到“未知发布 Profile”，不会回退；这是有意行为。
