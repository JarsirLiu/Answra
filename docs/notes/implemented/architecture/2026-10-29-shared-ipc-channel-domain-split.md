# Note：Shared IPC 频道按领域拆分

状态：已实施

## 问题

`packages/shared/src/channels.ts` 同时维护窗口、对话、截图、面试、工作区、账号和背景采样契约。随着功能增加，团队成员修改同一个大文件，领域边界只能依赖代码顺序，容易产生合并冲突和误改。

## 涉及范围

影响 `packages/shared` 的 IPC 契约目录，以及仓库协作规范中对频道契约位置的描述。既有 `@answra/shared` 和 `@answra/shared/channels` 导入路径保持不变。

## 决定

将频道契约按领域拆到 `packages/shared/src/channels/`：`window`、`ambient`、`capture`、`conversation`、`auth`、`interview`、`workspace`。每个文件同时维护该领域的频道常量、DTO 和 `ChannelMap`。`channels.ts` 只做聚合导出和兼容入口，新增频道必须进入对应领域文件。

## 曾考虑的替代方案

- **继续把所有契约追加到单一 `channels.ts`：** 舍弃，因为改动虽小，却会持续放大多人协作冲突和领域定位成本。
- **让各调用方直接从领域文件导入并删除聚合入口：** 舍弃，因为会造成一次性大范围迁移并破坏现有包导出路径；当前收益不足以抵消迁移风险。

## 模块边界

- `packages/shared/src/channels/*.ts`：各领域独立维护频道常量、DTO 和 `ChannelMap`。
- `packages/shared/src/channels.ts`：只负责聚合导出和保持既有包入口，不承载领域定义。
- `packages/shared/src/bridge.ts`：继续维护 renderer 可见的 `DesktopBridge`，不把 IPC 领域实现放入 shared。

## 后果与防回退

领域契约可独立维护，团队并行修改时冲突面缩小；`channels.ts` 仍是稳定入口，因此新增文件不会迫使下游立刻改 import。领域之间若需要共享类型，必须显式从对应领域模块导入，不能恢复向聚合文件堆定义。

## 验证

- `pnpm --filter @answra/shared typecheck` 通过。
- `pnpm notes:check` 与 `pnpm verify` 应在提交前通过。
- `AGENTS.md` 规定新增频道写入 `packages/shared/src/channels/` 对应领域文件，聚合入口不承载领域定义。
