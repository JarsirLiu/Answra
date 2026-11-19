# Note：品牌图标资源与开发窗口图标

状态：已实施

## 问题

安装包与开发态窗口没有统一的品牌图标：`build/` 下的 PNG/ICO/ICNS 仍是占位图，`pnpm dev` 打开的窗口显示 Electron 默认图标，无法在多窗口和任务栏里快速辨认；打包产物则依赖 electron-builder 从同一目录读取图标，两处来源不一致时会出现「开发态一个图标、安装版另一个图标」。

## 涉及范围

- 资源：`apps/desktop/build/icon.png`、`icon.ico`、`icon.icns`
- 代码/模块：`apps/desktop/src/main/mainWindowController.ts`（仅非打包态传入窗口 `icon`）
- 测试：`apps/desktop/test/mainWindowController.test.ts`（mock 补 `app.getAppPath`）
- UI 表面：桌面悬浮条窗口在开发态的标题栏/任务栏图标；安装版图标仍由 electron-builder 读取 `build/` 资源，不改打包流程

## 决定

- 用同一份品牌图形重新导出三套尺寸：`icon.png` 作为开发态窗口图标与 Linux/通用来源，`icon.ico` 供 Windows、`icon.icns` 供 macOS 打包。
- 只在 `app.isPackaged === false` 时向 `BrowserWindow` 传 `icon`，路径为 `path.join(app.getAppPath(), "build/icon.png")`；打包产物继续使用可执行文件内嵌图标，不在运行时读 `build/`。
- 不在窗口创建处引入图标缓存、主题变体或按平台分支的图标路径。

## 影响表面

- 开发态窗口与任务栏显示品牌图标；安装版图标由 electron-builder 统一嵌入，不受运行时路径影响。
- `build/icon.*` 成为唯一图标来源；替换图形时三个文件必须同时重新导出，否则各平台图标不一致。

## 曾考虑的替代方案

- **只在打包配置里指定图标，不改窗口创建：** 舍弃。开发态窗口仍是 Electron 默认图标，问题只解决一半。
- **运行时按平台拼不同文件名读取图标：** 舍弃。非打包态各平台都能读 `icon.png`，多一条分支只增加维护面积。
- **把图标打进渲染层资源并在 `BrowserWindow` 里引用 asar 内路径：** 舍弃。窗口图标属于主进程平台能力，渲染层资源不参与窗口创建。

## 后果与防回退

- 图标资源必须保持正方形，PNG 至少 512×512；`icon.ico`/`icon.icns` 从同一母版导出，禁止单独微调。
- 开发态图标路径依赖 `app.getAppPath()` 指向 desktop 包根目录；测试 mock 必须提供 `getAppPath`，否则窗口创建用例会抛错。
- 新增窗口时沿用同一份图标来源，不要在窗口模块里再定义图标路径常量。

## 验证

- `pnpm --filter @answra/desktop exec vitest run test/mainWindowController.test.ts`：窗口创建与生命周期用例通过。
- `pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm --filter @answra/desktop build:answer` 后再 `dist:win`：electron-builder 正常读取 `build/icon.ico` 并完成打包。
