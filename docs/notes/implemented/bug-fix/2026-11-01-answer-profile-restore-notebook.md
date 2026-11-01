# Note：answer Profile 恢复笔记本工作区

状态：已实施

## 问题

answer 公开发布包按功能裁切时把 `workspace` 一并排除，悬浮条上的「笔记本」入口和工作区面板随之消失。用户明确要求保留笔记本；这个功能不是内部调试能力，而是答题之外的日常记录入口。只把按钮显示出来也不够：answer 的 preload 没有暴露工作区 IPC，即使面板被渲染，目录选择、读写和 watcher 也会全部不可用。

## 涉及范围

- 代码/模块：`apps/desktop/release-profiles.json`、`apps/desktop/src/preload/answer.ts`、`apps/desktop/package.json`、`apps/desktop/test/releaseProfile.test.ts`
- UI 表面：悬浮条「笔记本」入口、工作区面板（笔记与资料）、设置面板宽度对照
- 开发流程：`pnpm dev` 默认 Profile、`pnpm dev:full`
- 相关 Note：[安装包功能裁切与发布 Profile](../architecture/2026-11-01-answer-only-release-profile.md)、[裁剪 answer 安装包的重复运行时依赖](../simplification/2026-11-01-trim-answer-installer-runtime-deps.md)、[answer Profile 设置面板宽度被视口钳制](2026-11-01-answer-panel-width-fit-content-clamp.md)

## 根因

`workspace` 同时拥有笔记/资料面板和主进程工作区服务。answer Profile 把它写在 `exclude` 中，构建期常量 `__ANSWRA_FEATURE_WORKSPACE__` 为 false，`WorkspaceControls` 因此不渲染「笔记本」，`FloatingBarApp` 也不挂载 `WorkspaceFeaturePanel`。answer 的 preload 是独立入口，只实现答题、设置、账号、公告、更新和窗口 API，没有 `WorkspaceChannels` 方法，所以单纯恢复功能位会得到一个看似存在但读写失败的面板。

同时，`pnpm dev` 一直使用 full Profile，开发态能看到笔记本，安装包看不到，问题只能在打包后暴露。

## 修复

- answer Profile 的 `include` 加入 `workspace`，`exclude` 只保留 `chat`、`interview`；工作区不再属于被裁掉的内部功能。
- `apps/desktop/src/preload/answer.ts` 补齐工作区桥接：根目录查询/选择、目录树、读写文本与字节、创建/删除条目、变更订阅。
- `pnpm dev` 改为 answer Profile，新增 `pnpm dev:full` 供聊天/面试开发；`pnpm dev:web` 同步默认 answer，并保留 `pnpm dev:web:full`。
- `releaseProfile.test.ts` 改为断言 answer 包含 `workspace`，同时继续排除 `chat` 和 `interview`。

## 决定

笔记本属于 answer 公开发布能力，工作区面板与主进程服务随之进入 answer 包；通用聊天和面试仍然排除。开发默认 Profile 与公开发布 Profile 一致，避免再出现“开发态正常、安装包缺失”的验收盲区。

## 曾考虑的替代方案

- **只恢复悬浮条按钮、不恢复 preload：** 舍弃。按钮能打开空壳面板，但目录选择和文件读写全部报“当前版本不支持”，比不显示更糟。
- **为笔记本新建独立 feature 和独立面板：** 舍弃。现有工作区已经把笔记与资料合并为同一面板，拆分会复制目录树、编辑器和预览链路，且需要新增跨进程契约；本次目标只是恢复既有能力。
- **继续保持 `pnpm dev` 为 full，仅新增 `dev:answer`：** 舍弃。用户需要默认开发窗口与安装包一致；全量能力仍可通过显式 `dev:full` 获得。
- **把 `chat` 一并加入 answer 以换取更宽的悬浮条：** 舍弃。聊天不是本次要求，且会重新引入聊天 runtime 和 UI；笔记本本身已能提供工作区入口。

## 后果与防回退

- answer 安装包会重新包含工作区面板及其渲染依赖，体积会比只含答题的 74 MB 基线增大；这是保留笔记本的明确代价。
- answer 仍不包含聊天、面试、VAD/ASR 和 sherpa 原生依赖，`audit-packaged-input.mjs` 继续校验这些模块不可达。
- 新增 answer 功能时必须同时检查 UI feature 位和 answer preload API；只有 UI 没有桥接属于不完整实现。
- `pnpm dev` 与 `pnpm dist:win` 使用同一个 `answer` Profile；需要 full 行为时使用 `pnpm dev:full`。

## 验证

- `apps/desktop/test/releaseProfile.test.ts`：answer 包含 `workspace`，不包含 `chat`/`interview`。
- `pnpm --filter @answra/desktop build:answer`：answer renderer 生成工作区 chunk，main 注册工作区组合，preload 包含工作区 API。
- `pnpm --filter @answra/desktop dist:win`：打包输入审计与最终 `app.asar` 审计通过，安装包可在设置面板旁看到「笔记本」并完成目录选择、文件读写。
- `pnpm dev`：默认启动 answer Profile，悬浮条入口与安装包一致；`pnpm dev:full` 仍可启动聊天与面试。
- 待办：在干净 Windows 虚拟机中验证笔记入口、目录选择、读写、外部文件变更刷新，以及设置面板宽度与开发态一致。

## 风险

- 工作区面板会增加 answer 安装包的 JS 体积，但不会带入 ASR 原生依赖或模型资源。
- 目录权限、缺失根目录和 watcher 行为仍依赖桌面平台实现，自动化测试不能替代 Windows 实机验收。
