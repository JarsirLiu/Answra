# Note：CLI 模型配置面板与模型选择器

状态：已实施

## 问题

CLI TUI 已经能在首次启动时引导填写 Base URL、API Key 和模型 ID，也能通过 `/model <ID>` 切换 chat 模型，但配置入口仍不完整：

- 只有 `/help`、`/clear`、`/model`、`/exit` 四个本地命令，用户看不到“修改整套模型配置”的入口。
- `/model` 无参数时只显示文本摘要，不能像 Claude Code 一样打开模型选择器；用户仍需记住模型 ID。
- Base URL 和 API Key 在 TUI 启动后无法修改；`/model add` 只接受空格分隔参数，不能编辑已有配置，也不能保留/清除 keychain 中的 API Key。
- 命令面板只有四条命令，`/` 后按 Enter 会先补全而不是执行当前选中项，用户感知为“不能选择命令”。
- 模型列表没有数据来源；如果只做静态列表，会与用户实际端点脱节。

本次补齐 `/config` 可搜索设置列表、`/model` 模型选择器和命令面板执行体验，并保持 API Key 不进入共享配置。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/model/catalog.ts`：模型目录端口与稳定错误。
  - `apps/cli/src/adapters/openAiModelCatalog.ts`：OpenAI 兼容 `GET /models` 适配器。
  - `apps/cli/src/tui/panel.ts`：TUI 面板类型与面板 handler 契约。
  - `apps/cli/src/tui/commands/configForm.ts`：设置项值、字段顺序与保存输入投影。
  - `apps/cli/src/tui/commands/configPresentation.ts`：字段标签、搜索过滤、当前值与 footer 的纯投影。
  - `apps/cli/src/tui/commands/ConfigPanel.tsx`：`/config` 状态编排（加载、搜索、编辑、保存）。
  - `apps/cli/src/tui/commands/ConfigList.tsx`：可搜索设置列表、行内编辑、44 列 label 与 API Key 回显。
  - `apps/cli/src/tui/commands/ConfigModelMenu.tsx`：`/config` 内的模型子选择器。
  - `apps/cli/src/tui/commands/ModelPicker.tsx`：`/model` 选择器。
  - `apps/cli/src/tui/composer/SearchBox.tsx`：Claude Code 风格搜索框。
  - `apps/cli/src/tui/chrome/PanelFrame.tsx`：Claude Code 风格的 Pane 顶部线、标题、说明与 footer。
  - `apps/cli/src/tui/app/viewStore.ts`、`apps/cli/src/tui/app/App.tsx`：面板状态与渲染；App 向 `/config` 注入 `loadModels`。
  - `apps/cli/src/tui/composer/PromptInput.tsx`：面板编辑态、命令面板 Enter 执行、Up/Down 循环。
  - `apps/cli/src/tui/runTui.tsx`：面板数据加载、保存、模型切换与 session 热更新。
  - `apps/cli/src/tui/commands/catalog.ts`、`parse.ts`、`dispatch.ts`、`modelCommand.ts`、`help.ts`：`/config` 与新的 `/model` 行为。
  - `apps/cli/src/cli/dependencies.ts`、`codeCommand.ts`、`main.ts`、`help.ts`：模型目录注入与帮助文案。
  - `apps/cli/src/session/codingSession.ts`：`setAccessToken()`。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI 和 CLI 组合根；不触达 Agent 事件、transcript 投影、IPC、desktop。
  - Base URL、chat/answer 模型仍写入共享 `config.json`；API Key 仍只写 `@answra/credentials` 的 OS keychain。
  - 模型列表来自当前 Base URL 的 OpenAI 兼容 `/models`，不新增持久化。
- 相关 Note：
  - [CLI 模型设置域与目录边界](../../implemented/architecture/2026-11-13-cli-model-settings-domain.md)
  - [CLI slash 命令候选与 Tab 补全](../../implemented/feature/2026-11-13-cli-slash-command-palette.md)
  - [CLI Coding 模式与终端 UI（TUI）移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)

## 决定

### 1. `/config` 可搜索设置列表

新增 `ConfigPanel`，打开后读取 `ModelSettings.snapshot()` 与 keychain 状态，按 Claude Code `/config` 的列表结构展示四项设置，不再有“保存并应用”行：

```text
模型配置
搜索设置…

❯ Base URL        https://integrate.api.nvidia.com/v1
  API Key         已保存 · ••••pnqR
  Chat 模型       nvidia/nemotron-3.5-super-vl...
  Answer 模型     与 Chat 相同
```

- 默认进入搜索模式；输入过滤 label，`Enter` 或 `↓` 进入列表，`Esc` 先清空查询、再退出搜索。
- 列表模式 `↑/↓` 循环选择，`Enter` 或 `→` 修改/打开子菜单，`Ctrl+S` 保存并关闭，`/` 重新搜索，`Esc` 取消并关闭；彻底移除 `Space` 修改别名。
- 文本字段在行内展开 `PromptInput`，`Enter` 确认、`Esc` 取消编辑；编辑时隐藏输入框指针，避免与列表 `❯` 重复。
- 模型字段打开 `ConfigModelMenu`：当前 chat 模型置顶并勾选；Answer 额外提供“与 Chat 相同”；`/models` 失败时提供“手动输入模型 ID…”。
- API Key 从 keychain 回填，默认掩码显示；列表选中 API Key 时 `Ctrl+R` 显示/隐藏完整值，编辑态同样支持，并默认使用保留尾部 4 位的等长掩码；离开行、打开其他编辑项、取消编辑或关闭后重置；完整值不进入输入历史、notice 或 transcript。
- footer 随搜索/列表/编辑/子菜单切换提示；列表 footer 为 `Enter/→ 修改 · Ctrl+S 保存 · / 搜索 · Esc 取消`，选中 API Key 时追加 `Ctrl+R 显示/隐藏 Key`。
- Base URL 和 Chat 模型必填；Answer 模型留空表示与 Chat 相同。
- API Key 未改动时保存为 `keep`，不重写 keychain；输入新值覆盖；清空或输入 `-` 表示清除。
- 保存顺序：校验 → `ModelSettings.addLocal()` 写非 secret 配置 → 更新 keychain → 更新/创建 session → 更新视图状态。
- 保存失败时面板不关闭，错误留在面板内；保存成功调用 `close("saved")`，Esc 关闭调用 `close("dismissed")`；有变更时 notice 为 `Set <key> to <value>` 或 `Set API key`/`Cleared API key`，无变更或 Esc 为 `Config dialog dismissed`。

### 2. `/model` 选择器

新增 `ModelPicker`，无参数 `/model` 打开；`/model <ID>` 保留为直接切换。

- 当前模型始终置顶并显示 `✓`；列表来自 `GET {baseUrl}/models`。
- 请求带 `Authorization: Bearer <API Key>`，5 秒超时，解析 `data[].id`，去重排序。
- `↑/↓` 选择，`Enter` 切换，`Esc` 取消；最多显示 10 项，超出显示 `and N more…`。
- `/models` 失败时显示错误和当前模型，提示用 `/model <ID>` 或先 `/config`。
- `/model add ...` 不再支持，提示改用 `/config`。
- 运行中拒绝打开 `/config` 或 `/model`。

### 3. 命令面板

- catalog 增加 `config`，命令顺序为 `/help`、`/clear`、`/config`、`/model`、`/exit`。
- `↑/↓` 循环选择。
- 输入 `/` 或完整命令名/别名时，`Enter` 直接执行选中命令；输入 `/mo` 这类前缀时仍先补全。
- `Tab` 补全，`Esc` 关闭候选。
- 面板打开时禁用 App 的全局 Esc/取消快捷键，避免误取消 run。

### 4. 面板 UI

- `/config` 使用 Claude Code 的设置列表结构：顶部 `SearchBox`、左侧 44 列 label、右侧当前值、`❯` 焦点、底部 footer；不再显示行尾 `›`，右侧值列按终端宽度显式计算，避免撑出宽空列。
- 文本字段只在 `Enter` 后展开行内编辑器；模型字段打开嵌入子菜单，不把输入框常驻在列表里。
- 模型子菜单复用列表项 `❯`/`✓`、`success` 选中色、`suggestion` 焦点色与 dim 描述。
- 不复制 Claude Code 的完整 `Settings`/`Select` 组件；只移植搜索框、列表行、子菜单和按键映射，保持 Answra 的 Ink/theme 依赖面。

### 5. 明确不做

- 不做多套 endpoint profile、模型下载、能力探测或云端登录。
- 不把 API Key 写入共享配置、transcript 或输入历史；仅在配置面板内按需显示。
- 不引入自定义 slash command/skill/plugin。
- 不保留 `/model add`。
- 不保证 keychain 与共享 config 的跨存储原子性。

## 影响表面

- `/config`：可搜索设置列表；`Enter`/`→` 编辑/打开子菜单，`Ctrl+S` 保存并热更新当前会话；Base URL、API Key、Chat/Answer 模型均可修改。
- `/model`：无参数打开模型选择器；`/model <ID>` 仍可直接切换；`/model add` 给出迁移提示。
- 命令面板：五条命令、Up/Down 循环、`/` + Enter 执行选中项。
- 帮助：`/help` 与 `answra --help` 增加 `/config`，移除 `/model add`。
- 失败：`/models` 不可用时不影响当前模型；保存失败时面板保留并显示错误。

## 曾考虑的替代方案

- **只增加 `/config` 子命令，不做面板：** 舍弃。用户仍要记参数顺序，无法看到当前 Base URL/API Key 状态，也不符合 Claude Code 的交互预期。
- **保留 `/model add` 作为配置入口：** 舍弃。它不能编辑已有配置、不能保留/清除 key，且与 `/config` 形成两个写入口。
- **继续使用字段铺开的表单：** 舍弃。字段没有“可编辑”信号，选中态弱，API Key 像只读状态，“保存并应用”混在字段里；改为可搜索列表 + `Enter` 编辑。
- **照搬 Claude Code 的 `Space` 修改：** 舍弃。`Space` 不是终端里通用的确认键，用户难以发现；改为 `Enter`/`→` 修改、`Ctrl+S` 保存，并彻底移除 `Space` 别名。
- **把编辑框常驻在每行下方：** 舍弃。列表会变成多行表单，当前值和入口反而更难扫读；只在 `Enter` 后展开行内编辑。
- **只做静态模型列表：** 舍弃。模型 ID 与用户端点强相关，静态列表会误导；`/models` 失败时保留手动输入回退。
- **API Key 只显示“已保存”，不回填也不允许查看：** 舍弃。用户无法确认当前 key，也无法原地修改；改为默认掩码回填，列表与编辑态均可 `Ctrl+R` 按需显示。
- **把 API Key 写入共享 config：** 舍弃。破坏现有 keychain 安全边界，桌面与 CLI 都会读到明文。
- **在 TUI 内直接 `fetch`：** 舍弃。TUI 只依赖端口，HTTP、超时和错误码由 adapter 持有，便于测试和替换。
- **复制 Claude Code 的完整 Settings/Select 组件：** 舍弃。依赖过多、与 Answra 的 Ink/theme 不一致；只移植搜索框、列表行、子菜单和按键映射。
- **`/` + Enter 继续先补全：** 舍弃。用户明确希望选中后执行；前缀补全仍保留。

## 验证

- 可观察结果：
  - `/config` 显示四项设置与搜索框；默认搜索模式，输入 label 可过滤，`Enter`/`↓` 进入列表，`Enter`/`→` 打开编辑。
  - 列表模式 `Enter`/`→` 打开行内编辑或模型子菜单，`Ctrl+S` 保存，`/` 搜索，`Esc` 取消/关闭；footer 随模式变化。
  - API Key 从 keychain 回填并默认掩码显示；列表选中 API Key 时 `Ctrl+R` 可显示/隐藏，编辑态同样支持；未修改时不重写 keychain，共享 config 不含 secret。
  - `/model` 打开选择器，当前模型置顶并勾选；Up/Down/Enter/Esc 可用。
  - `/models` 失败时显示错误，当前模型仍可选择，提示 `/model <ID>`；`/config` 模型子菜单同时提供手动输入。
  - `/` 后 Up/Down 选择，Enter 直接执行；`/mo` + Enter 仍先补全。
- 自动化验证：
  - `commands.test.ts`：catalog、帮助、解析、补全。
  - `runTui.test.ts`：打开面板、保存配置、切换模型、运行中拒绝。
  - `configPanel.test.tsx`：搜索过滤、`Enter`/`→` 编辑、`Ctrl+S` 保存、API Key 列表/编辑态回显、模型子菜单、Answer 与 Chat 相同、手动模型回退、校验错误、Esc dismissed。
  - `configPresentation.test.ts`：label 过滤、当前值投影、API Key 掩码与 footer 模式。
  - `modelPicker.test.tsx`：当前模型置顶、切换、错误与截断。
  - `modelCatalog.test.ts`：URL、Bearer、解析、去重、HTTP/格式/超时错误。
  - `commandPalette.test.tsx`：`/` + Enter 执行，前缀仍补全。
  - `codingSession.test.ts`：`setAccessToken()` 影响下一次 send。
- 已执行：
  - `pnpm --filter @answra/cli typecheck` 通过。
  - 定向 vitest：`configForm.test.ts`、`configPresentation.test.ts`、`configPanel.test.tsx`、`runTui.test.ts` 共 42 个用例通过。
  - 全量 `pnpm --filter @answra/cli test` 仍受并行测试目录迁移影响（`tui.test.tsx`、`inputLayout.test.ts` 的编码与字形断言失败），不属于本功能改动。
- 需要的实机验证：
  - Windows Terminal / VS Code 集成终端中的中文、光标、面板高度与搜索框宽度。
  - `/models` 真实端点成功/失败两种路径。
  - 运行中 Esc 不被面板抢走。

## 后果与防回退

- 后果：`/config` 成为唯一整套模型配置入口，`/model` 负责选择与切换；用户不再需要记 `/model add` 参数顺序。
- 后果：`/config` 从表单改为可搜索列表，当前值与 footer 同时可见；模型编辑进入子菜单，文本编辑只在 `Enter`/`→` 后展开。
- 后果：API Key 在配置面板内可见，但默认掩码、列表与编辑态均可 `Ctrl+R` 显示，且不进入共享配置、transcript 或输入历史。
- 防回退：保留 `/model <ID>` 手动回退，`/models` 不可用时仍能切换模型；`/config` 模型子菜单在目录失败时提供手动输入。
- 防回退：`runTui.test.ts` 覆盖“未修改 API Key 不重写 keychain”，`configForm.test.ts` 覆盖 `keep/clear/set` 投影，防止再次把空输入误判为清除。
- 防回退：`configPanel.test.tsx` 覆盖搜索过滤、`Enter`/`→` 编辑、列表/编辑态 API Key 回显、`Ctrl+S` 保存、模型子菜单、手动模型回退和 Esc dismissed，防止退回“字段铺开表单”或只支持 `Space` 编辑。
- 风险：共享 config 与 keychain 不是同一事务；保存中途失败可能只完成一半，面板保留错误供重试。
- 风险：模型列表可能包含不兼容模型；选择后实际运行仍可能失败，本次不做能力探测。
- 风险：搜索只按 label 过滤，不搜索当前值；长 Base URL/模型 ID 在列表中截断，完整值需进入编辑查看。
- 风险：面板高度受终端 rows 限制；极小终端下列表需要滚动/截断，不能保证所有字段同屏。
- 风险：完整 API Key 只在用户按 `Ctrl+R` 时出现在终端；仍可能被终端回滚或录屏捕获，不写入 notice、transcript 或输入历史。
- 风险：真实 TTY 的宽字符和光标行为只能由实机验收，组件测试只覆盖渲染与按键分支。
