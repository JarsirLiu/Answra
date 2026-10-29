# Note：生产安装包构建加固与逆向边界

状态：已实施

## 问题

Electron 客户端的 JavaScript 必须在用户设备上运行，无法通过打包实现绝对保密。原配置还包含无 `from` 的 `extraResources` 全量通配项，可能把开发目录中的非运行时文件带入安装包；main、preload、worker 与 renderer 的生产构建也没有显式声明压缩和 source map 策略。

## 涉及范围

- `apps/desktop/scripts/build-electron.mjs`：Electron 进程 bundle 的生产编译选项。
- `apps/desktop/vite.config.ts`：renderer 生产构建选项。
- `apps/desktop/package.json`：electron-builder 文件白名单、资源白名单、压缩和打包前审计命令。
- `apps/desktop/scripts/audit-packaged-input.mjs`：打包输入目录审计。

## 决定

- main、preload、selection preload 和 agent worker 显式启用 esbuild 压缩，关闭 source map，并移除构建注释。
- renderer 显式关闭 source map，使用 Vite 的生产压缩。
- 删除 `extraResources` 的项目根目录全量通配，只保留明确的资源目录（当前配置为 `resources/vad`；未来加入 ASR 资源时也必须显式列出）。
- electron-builder 使用 ASAR、最大压缩和 `removePackageScripts`；`dist:win` 在生成安装包前执行审计，发现 `.ts`、`.tsx`、`.map` 等文件立即失败。
- 核心授权、额度、模型路由和长期密钥继续由服务端控制；客户端加固只提高提取和分析成本，不作为机密存储方案。

## 模块边界

- 构建脚本负责生成可分发 bundle 和构建期审计，不负责运行时授权。
- electron-builder 负责把明确的运行时文件装入 ASAR/资源目录，不负责隐藏 JavaScript 逻辑。
- 服务端负责账号、设备、能力、额度和请求授权，是不可交给客户端的安全边界。

## 曾考虑的替代方案

- **只依赖 ASAR：** 舍弃，因为 ASAR 是可读取的归档格式，不能阻止解包和静态分析。
- **引入强 JavaScript 混淆作为默认保护：** 当前舍弃，因为 Electron main/preload、动态加载和诊断链路存在兼容风险；先用压缩、无 source map、资源白名单和服务端授权建立低风险基线，后续对特定 bundle 做实测后再引入。
- **把核心模型、密钥和授权规则放进客户端：** 舍弃，因为客户端可被调试或修改，无法承担长期秘密和最终授权判断。

## 后果与防回退

- 生产 bundle 仍可能被逆向；本 Note 不声称提供不可逆或绝对防复制能力。
- 新增本地资源必须在 `extraResources` 中使用明确 `from` 和目标目录，禁止恢复项目根目录 `**/*` 通配。
- 新的发布入口必须经过 `audit:packaged`；若未来引入混淆，必须补充 Windows/macOS 打包和启动、IPC、更新流程的实测证据。

## 验证

- `pnpm verify`：lint、全包 typecheck、Agent/UI/Desktop 测试和架构检查通过。
- `pnpm --filter @answra/desktop build:electron`：bundle 构建通过。
- `pnpm --filter @answra/desktop audit:packaged`：构建输入不含源码和 source map。
- `pnpm notes:check` 与 `git diff --check` 通过。
