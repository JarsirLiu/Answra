# Note：桌面快捷方式显示内部 Electron 架构说明

状态：已实施

## 问题

Windows 桌面快捷方式悬浮提示显示：

```text
Electron 桌面壳：main/preload/renderer 三进程，renderer 只做薄壳，业务 UI 在 @answra/ui。
```

这是给仓库协作者看的内部架构说明，不是用户可见的产品描述；安装后出现在桌面和开始菜单快捷方式上，暴露实现细节且与产品定位无关。

## 涉及范围

- `apps/desktop/package.json`：`description` 字段，NSIS 安装包与快捷方式描述的来源。
- 已安装的桌面/开始菜单快捷方式（需要重新构建并安装后才会更新）。
- 不改动应用窗口标题、可执行文件版本信息、更新源或安装目录。

## 根因

electron-builder 的 NSIS 模板在创建桌面/开始菜单快捷方式时，把 `${APP_DESCRIPTION}` 作为 `CreateShortCut` 的描述参数：

```text
CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
```

`APP_DESCRIPTION` 由 NsisTarget 从 `appInfo.description` 传入，而 `appInfo.description` 直接取 `apps/desktop/package.json` 的 `description`。该字段此前被写成内部进程边界说明，因此 NSIS 把它原样写进了 `.lnk` 的 `Description`，Explorer 悬浮时显示为长串解释。

可执行文件自身的版本信息由 `productName` 生成，所以 `Answra.exe` 的属性显示 `Answra`，与快捷方式描述不一致。

## 修复

- 将 `apps/desktop/package.json` 的 `description` 改为用户可读的产品描述：`AI 面试与笔试助手`。
- 保留 `productName: "Answra"` 作为应用名和可执行文件名。
- 不改 NSIS 模板或构建脚本；electron-builder 会继续把包描述写入快捷方式。

## 决定

- 包描述面向安装用户，不再承载仓库架构说明；进程边界和目录职责继续由 `AGENTS.md` 与架构 Note 维护。
- 不在构建后直接修改 `.lnk` 文件，也不在安装器里写第二套快捷方式描述；保持 electron-builder 的单一来源。
- 老版本已创建的快捷方式不会自动改写；重新构建安装包并覆盖安装后，NSIS 会重新生成快捷方式。

## 曾考虑的替代方案

- **用 `build.extraMetadata.description` 覆盖打包元数据：** 可以保留 workspace 包的内部描述，但会多出一个只影响安装包的描述来源，排查时容易混淆；当前包描述本身没有必须保留的内部语义，舍弃。
- **构建后脚本直接修改桌面和开始菜单 `.lnk` 的 Description：** 会绕过安装器、依赖用户机器上的固定路径，且卸载/升级时容易残留；舍弃。
- **把架构说明放进 `build.win` 的某个自定义字段：** electron-builder 没有面向快捷方式描述的独立字段，最终仍会回落到包描述；引入无效配置只会制造假安全感，舍弃。
- **保留长描述但截断显示：** 快捷方式提示没有可控的换行或截断策略，且内部术语仍会暴露；舍弃。

## 后果与防回退

- 新安装包和重新创建的快捷方式悬浮提示会显示“AI 面试与笔试助手”，不再出现 Electron 进程架构说明。
- `apps/desktop/package.json` 的 `description` 不得再写内部架构、构建流程或仓库协作说明；这些内容应进入 `AGENTS.md`/`docs/notes/`。
- 若未来需要更长的商店描述，应使用发布渠道的产品文案，不要把多段说明塞回包描述。
- 仅改源码不会更新用户已安装的快捷方式；验收必须基于重新构建并安装的包。

## 验证

- `node -e "JSON.parse(require('node:fs').readFileSync('apps/desktop/package.json','utf8'))"`：通过，JSON 合法。
- 检查 `apps/desktop/package.json`：`description` 为 `AI 面试与笔试助手`，`build.productName` 仍为 `Answra`。
- 构建后检查安装目录快捷方式的 `Description`，应等于新的包描述；本 Note 记录的是源码修复，安装包验收需在重新打包后执行。
