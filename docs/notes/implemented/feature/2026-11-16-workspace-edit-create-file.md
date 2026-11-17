# Note：Edit 工具支持创建文件

状态：已实施

> 2026-11-17 修订：本 Note 中“已存在空文件回填必须先 Read”和“创建后更新会话读取状态”已被 [移除工具读前状态与 Edit 读前门禁](../simplification/2026-11-17-remove-tool-read-state-and-edit-read-gate.md) 取代。当前 Edit 自读确认空文件后回填，不再维护会话状态。

## 问题

CLI coding Agent 只有 `Read`、`Grep`、`Edit`、`RunCommand` 四个工具。`Edit` 原先只允许修改已存在文件：

- `old_string` 必须非空；
- 目标文件必须能通过 `realpath`；
- 当时必须先完整 `Read` 并持有读取基线（2026-11-17 起移除）。

因此新建源码、测试或配置文件没有专用路径。coding prompt 又禁止用 shell 覆盖整个文件，模型只能违反提示词或失败。

用户明确决定不新增独立 `Write` 工具，而是让现有 `Edit` 承担“空 `old_string` 创建新文件”的能力，避免模型看到两个语义相近的文件写入工具。

## 涉及范围

- `apps/agent/src/core/tool/builtin/edit.ts`：输入 schema、创建/覆盖分支、输出与校验。
- `apps/agent/src/core/tool/builtin/workspace.ts`：写目标解析与独占创建辅助。
- `apps/agent/src/coding/policy.ts`：coding prompt 明确新建文件使用空 `old_string`。
- `apps/agent/test/core/tool/edit.test.ts`：创建、空文件、已存在空文件回填、已存在非空文件拒绝、缺失目标拒绝、输入校验。
- `packages/ui/src/components/tool-call/renderers/edit.tsx`、`packages/ui/src/tool-presentation/tools/edit.ts`：接受 `type: "created"`，显示 Created 和新增行 diff。

## 影响表面

- 模型可以在同一 `Edit` 工具里新建文件或修改已有文件，不需要学习第二个文件写入工具。
- 新文件创建会出现在工具卡中，显示 `Created` 和新增行 diff；已有文件仍显示 `Edited`。
- 已有空文件可以用空 `old_string` 回填；Edit 自己读取并确认内容为空，不再要求先 `Read`。已有非空文件仍要求精确替换，不会因为创建模式而放宽。
- 工具输出新增 `type: "created"`；旧客户端若只识别 `edited` 会把它当作未知结构化输出，需要同步更新展示层。

## 决定

- 当 `old_string` 为空字符串时进入创建模式：
  - 目标文件不存在：父目录必须存在且解析为真实目录；使用独占创建；文件为 UTF-8、无 BOM、LF；`new_string` 允许为空；输出 `type: "created"`、`replacements: 0`。
  - 目标文件已存在但内容为空：Edit 自读确认内容为空后，按原编码/BOM/行尾/权限写回；输出同样是 `type: "created"`。
  - 目标文件已存在且内容非空：拒绝，不静默覆盖。
- 当 `old_string` 非空时保持原有编辑语义：
  - 目标必须存在；
  - Edit 自读当前文件，不要求历史 `Read`；
  - `mtimeMs`/`sizeBytes` 必须与本次自读一致；
  - 原子写回并保留编码、BOM、行尾和权限。
- 空 `old_string` + 已存在非空文件：拒绝。整文件覆盖不做隐式支持，必须提供原文做精确替换。
- 非空 `old_string` + 目标不存在：拒绝，并提示用空 `old_string` 创建。
- 创建和编辑成功后不再维护会话读取状态；后续连续编辑由每次 Edit 自读支持。
- 不新增 `workspace.write` 工具，也不把 `workspace.write` 授权给任何 profile。

## 曾考虑的替代方案

- **新增独立 Write 工具：** 用户明确否决。会增加模型可见工具数量和 `Write`/`Edit` 的语义选择成本。
- **让 Edit 用空 `old_string` 覆盖已有非空文件：** 舍弃。会把“创建/空文件回填”和“整文件覆盖”混在一起，并绕过空文件确认与精确替换。
- **允许 Edit 自动创建父目录：** 暂不。路径拼写错误会静默生成目录；v1 要求父目录存在。
- **继续用 shell 重定向写文件：** 舍弃。绕过编码/BOM/行尾保留、写前 stat 校验、原子写和输出预算。

## 后果与防回退

- 模型现在可以用一个 `Edit` 工具完成新建和修改，不需要额外工具。
- 覆盖已有非空文件仍只允许精确替换；已有空文件由 Edit 自读确认后回填。
- 防回退：
  - 不得让空 `old_string` 覆盖已存在非空文件；
  - 不得让已有空文件跳过“自读并确认内容为空”；
  - 不得移除编辑路径的自读与 `mtimeMs`/`sizeBytes` 校验；
  - 不得让创建路径静默覆盖或自动创建父目录；
  - 不得新增独立 `workspace.write` 工具；
  - 不得恢复会话级读取状态或创建后状态回填。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/tool/edit.test.ts`
- `pnpm --filter @answra/ui exec vitest run test/toolPresentation.test.ts test/toolCallRenderers.test.tsx`
- 覆盖：创建 UTF-8 文件、空文件、已存在空文件自读后回填、已存在非空文件拒绝、缺失目标拒绝、VCS/目录目标拒绝、创建 diff、模型输出。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/ui typecheck`。
