# Note：差异更新文件随发布清单上传

状态：已实施

## 问题

Windows 的 `electron-updater` 通过 `latest.yml` 发现新版本，并按安装包同名的 `.blockmap` 文件计算差异下载。原上传脚本只解析清单中的安装包 URL，未把 `.blockmap` 加入 COS 上传集合；线上会出现能发现版本但无法使用差异文件的发布状态。

## 涉及范围

- `apps/desktop/scripts/upload-to-cos.mjs`：从发布清单收集并校验上传文件。
- `apps/desktop/package.json`：Windows NSIS 构建产出 blockmap 的既有配置。
- `apps/desktop/src/main/updater/updateController.ts`：客户端检查和下载更新的既有入口。

## 根因

`latest.yml` 的 `url` 字段只列出安装包；blockmap 是 electron-builder 的并列产物，由 updater 按约定文件名单独请求。上传脚本把 URL 列表误当成完整发布文件列表。

## 决定

## 修复

- 解析安装包 URL 时推导同名 `.blockmap` 并在文件存在时加入上传集合。
- Windows `.exe` 缺少对应 blockmap 时让发布命令立即失败，避免生成不完整的 latest 目录。
- 其他安装包格式没有 blockmap 时保留兼容性，仍可按完整包更新。

## 曾考虑的替代方案

- **手工在 COS 控制台补传 blockmap：** 舍弃，因为容易漏传且不能作为可重复的发布流程。
- **只继续上传 latest.yml 与安装包：** 舍弃，因为无法保证差异下载所需的旁路文件存在。

## 后果与防回退

- `upload-to-cos.mjs --dry-run` 的文件列表必须同时包含 Windows 安装包和 `.blockmap`。
- COS 的 `download/latest/` 仍需由发布者实际上传；仓库代码不能证明远端对象已经存在。

## 验证

- `pnpm --filter @answra/desktop build:electron` 与 `vite build` 通过。
- `pnpm --filter @answra/desktop audit:packaged` 通过。
- 使用真实 NSIS 产物运行 `node apps/desktop/scripts/upload-to-cos.mjs --dry-run`，列表包含 `latest.yml`、安装包和 `.blockmap`。
- `pnpm notes:check`、`pnpm verify` 和 `git diff --check` 通过。
