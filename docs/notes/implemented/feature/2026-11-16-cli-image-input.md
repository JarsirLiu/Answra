# Note：CLI 图片输入与领域分层

状态：已实施

## 问题

CLI coding 原先只能发送文本。用户从 Claude Code 切过来后，期望在输入框直接粘贴截图或图片路径，并在 transcript 中看到图片标记。现状有三个断点：

- 图片读取逻辑放在 `apps/cli/src/tui/interaction/imagePaste.ts`，把 `node:child_process`、`node:fs`、临时文件等平台 I/O 混进“终端交互原语”。
- `PromptInput` 没有附件状态，`runTui` 队列只收 `string`，`CodingSession.send` 固定发送 `{ text, images: [] }`。
- `MessageRow` 的 user 分支只渲染文本，transcript 看不到图片。

Agent 侧的 shared 契约、transcript 持久化和模型投影本来就支持图片；此前只有 coding 域显式拒绝图片并在当前轮消息中丢掉图片。

## 涉及范围

- `apps/cli/src/image/attachment.ts`（新增）：图片附件类型别名、数量/大小上限、图片标签；只依赖 `@answra/shared`。
- `apps/cli/src/image/path.ts`（新增）：从粘贴文本识别绝对图片路径的纯函数；不读文件。
- `apps/cli/src/image/ports.ts`（新增）：`ImageAttachmentReader` 端口。
- `apps/cli/src/adapters/imageAttachmentReader.ts`（新增）：Node 平台实现，封装 PowerShell、osascript、wl-paste、xclip、临时文件、文件读取和 8 MB 校验。
- `apps/cli/src/tui/composer/usePromptAttachments.ts`（新增）：附件状态与读取编排；只依赖端口。
- `apps/cli/src/tui/composer/AttachmentBar.tsx`（新增）：渲染 `[Image #n] name`。
- `apps/cli/src/tui/composer/PromptInput.tsx`：Ctrl+V、图片路径粘贴、附件展示、空输入 Backspace 删除、图片-only 提交。
- `apps/cli/src/tui/app/App.tsx`、`runTui.tsx`：透传 reader；队列改为 `{ text, images }`。
- `apps/cli/src/session/codingSession.ts`：`send(text, images = [])`。
- `apps/cli/src/tui/transcript/UserImages.tsx`（新增）、`MessageRow.tsx`、`virtualLayout.ts`：渲染图片并计入虚拟列表高度。
- `apps/agent/src/coding/application.ts`、`apps/agent/src/coding/context.ts`：最小图片透传；不改 `core/agent`、worker 协议、shared schema 或 desktop。

## 决定

### 1. 分层

```text
src/image/attachment.ts     共享图片类型、限制、标签
src/image/path.ts           纯路径识别
src/image/ports.ts          ImageAttachmentReader
        ↑
src/adapters/imageAttachmentReader.ts   Node 剪贴板/文件实现
        ↑
src/tui/composer/usePromptAttachments.ts  附件状态 + 端口调用
src/tui/composer/AttachmentBar.tsx        附件展示
        ↑
src/tui/composer/PromptInput.tsx          输入编排
src/tui/app/App.tsx                       透传
src/tui/runTui.tsx                        组合根、队列、发送
        ↑
src/session/codingSession.ts              用例参数透传
```

- `src/image` 只放领域类型、限制和纯函数；不读文件、不调命令、不 import Ink/React。
- `src/adapters/imageAttachmentReader.ts` 是唯一接触 Node 平台 I/O 的图片入口。
- `src/tui/composer` 只认识 `ImageAttachmentReader` 端口，不直接读剪贴板。
- `src/tui/transcript` 只消费 `ConversationViewMessage.images`，不读文件、不生成 data URL。
- `src/session` 只把附件从用例带到宿主端口，不读取图片。
- `runTui` 是组合根：创建 Node adapter，注入 App，并把队列项交给 `CodingSession`。

### 2. 行为

- `Ctrl+V` 读取系统剪贴板图片；剪贴板没有图片时给出 notice。
- 粘贴内容若是绝对图片路径（单行或多行，每行一个），读取文件并转成 data URL；路径不是图片或读取失败时保留为文本或给出错误。
- 输入框上方显示 `[Image #1] name` 等附件；空输入时 Backspace 删除最后一张，Esc/Ctrl+C 清空附件。
- 允许图片-only 提交；有图片时 Enter 不再被“空输入”拦截。
- transcript 的 user 消息显示 `[Image #n] name`；不在终端渲染位图。
- 虚拟列表把图片行计入高度估算和测量 key。

### 3. 明确不做

- 不复制 Claude Code 的 `imageStore`、`imageResizer`、native NSPasteboard；当前不做磁盘缓存和转码。
- 不新增图片压缩依赖；超过 8 MB 直接给出错误。
- 不把附件状态写进 `TuiViewStore`、Agent 事件或共享配置。
- 不在本轮改 `core/agent` 的模型执行、worker 线协议或 desktop；图片能力沿用 shared 契约和已有 transcript 投影。

### 4. 模块边界

输入框只持有附件状态和端口调用，不持有剪贴板命令；Node adapter 只返回值对象，不 import React/Ink；Agent coding 域只消费 `ConversationSendRequest.images`，不新增第二套图片协议。

## 影响表面

- 用户可见：CLI 输入框支持剪贴板图片和图片路径；attachment bar；图片-only 提交；transcript 图片标记。
- 命令/配置：`runTui` 队列项从字符串变为 `{ text, images }`；`CodingSession.send` 增加可选第二参数，现有调用保持兼容。
- 持久化：图片随 transcript 消息进入既有会话文件，不新增图片目录。
- 失败提示：剪贴板无图片、格式不支持、超过 8 MB、超过 8 张时通过 notice 或 attachment bar 提示。

## 曾考虑的替代方案

- **把 `imagePaste.ts` 继续留在 `tui/interaction`：** 舍弃。它包含 Node 平台 I/O，不符合该目录“终端交互原语”的约束，也会让 composer 间接依赖平台命令。
- **把读取逻辑放进 `CodingSession`：** 舍弃。会话用例只编排发送/等待/取消，不应读文件或剪贴板。
- **直接照搬 Claude Code 的 imageStore/imageResizer：** 舍弃。需要额外缓存目录、Sharp/native 依赖和清理策略；当前 shared transcript 已能携带 data URL，先以最小可用路径落地。
- **把图片标记直接插入输入文本（Claude Code 的 `[Image #N]` pill）：** 本次不做。当前输入布局是自研 grapheme/视觉行模型，先把附件作为独立状态接入，避免同时改动光标、选区和 token 删除；后续若需要 pill 交互再单独设计。
- **只在 macOS 支持空粘贴读剪贴板：** 舍弃。CLI 在 Windows 上是主要使用场景；使用显式 Ctrl+V + 路径粘贴覆盖。
- **让 CLI 自己把图片压缩到 5 MB：** 舍弃。没有现成图像处理依赖，且 Agent 当前接受 8 MB；先做明确拒绝，避免引入大依赖。

## 后果与防回退

- 图片读取只能出现在 `src/adapters/imageAttachmentReader.ts`；`src/tui/composer` 不得重新 import `node:child_process`、`node:fs` 或平台命令。
- `PromptInput` 不得把图片 base64 写入 `TuiViewStore` 或 Agent 事件；附件状态只存在于 composer hook，提交时一次性交给 `runTui`。
- `runTui` 队列项必须保持 `{ text, images }`，不能再退回单一 `string`，否则图片-only 和排队图片会丢失。
- transcript 渲染必须消费 `ConversationViewMessage.images`，不能从文本中解析图片标记来反推附件。
- 虚拟列表高度估算必须继续计入 `message.images.length`，否则图片出现后滚动位置会跳变。
- 单张 8 MB、单次 8 张的限制由 Agent `validateModelRequest`/`parseDataUrl` 作为最终边界；CLI 侧只做前置提示，不能放宽。

## 验收标准

- 可观察结果：
  - `Ctrl+V` 从剪贴板粘贴截图后，输入框上方出现 `[Image #1]`，Enter 发送，user transcript 显示图片标记。
  - 粘贴 `C:\shots\capture.png` 或 `/tmp/capture.png` 后，图片被读取为附件，而不是作为普通文本插入。
  - 图片-only 输入可发送；Backspace 在空输入时删除最后一张；Esc/Ctrl+C 清空附件。
  - 超过 8 张或单张超过 8 MB 时有明确提示；剪贴板无图片时有 notice。
  - 图片消息出现后，虚拟 transcript 的滚动位置不因高度估算错误而跳动。
- 自动化验证：
  - `apps/cli/test/image/path.test.ts`、`apps/cli/test/adapters/imageAttachmentReader.test.ts`。
  - `apps/cli/test/tui/composer/tui.composer.test.tsx`。
  - `apps/cli/test/tui/transcript/tui.transcript.test.tsx`、`virtualLayout.test.ts`。
  - `apps/cli/test/session/codingSession.test.ts`、`apps/cli/test/tui/runTui.test.ts`。
  - `apps/agent/test/coding/application.test.ts`。
- 需要的实机验证：
  - Windows Terminal / VS Code 集成终端下 Ctrl+V 截图、拖入/粘贴路径、中文路径、8 MB 边界。
  - macOS/Linux 的剪贴板实现未在本机验证前不得声称跨平台已验收。

## 验证

- 2026-11-16：`pnpm --filter @answra/cli typecheck` 通过。
- 2026-11-16：`pnpm --filter @answra/cli test` 通过 49 个测试文件、305 个测试；新增图片路径、reader、composer、transcript、session、runTui 覆盖。
- 2026-11-16：`pnpm --filter @answra/agent test` 通过 78 个测试文件、574 个测试；`coding/application.test.ts` 覆盖图片请求、图片-only、后续 transcript 上下文保留图片。
- 2026-11-16：`pnpm lint`、`pnpm typecheck`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm notes:check` 通过。
- 2026-11-16：真实文件路径读取 `createImageAttachmentReader().readPath(...)` 通过，返回 `data:image/png;base64,...`。
- 2026-11-16：Windows 剪贴板读取调用可返回空数组而不崩溃；当前测试时剪贴板没有图片，真实截图路径仍需实机验收。
- 2026-11-16：全仓 `pnpm verify` 在 `packages/ui` 的 `FloatingBarApp.navigation.test.tsx` 超时失败；单独重跑该文件 9/9 通过。该文件不在本轮改动范围，属于并发负载下的既有 UI 抖动。
- 待完成：Windows Terminal / VS Code 集成终端实机 Ctrl+V 截图、中文路径和 8 MB 边界验收；未完成前不能把 Windows 剪贴板路径当作已验收。

## 风险

- Windows Terminal 可能拦截 Ctrl+V，图片粘贴只能走路径/终端自身粘贴；需要实机确认，失败时保留明确的路径输入路径。
- 大图 data URL 会让 transcript 快照和会话文件变大；当前接受这个代价，后续再评估缩略图/磁盘引用。
- 模型必须支持视觉输入；当前没有能力探测，模型不支持时由 provider 返回错误。
- Backspace 删除最后一张只在输入框为空时生效；光标在文本中间时仍编辑文本，避免与现有编辑语义冲突。
- 多路径粘贴只支持“每行一个绝对路径”；带空格且未加引号的混合文本不自动拆分，避免误吞普通文本。
- `PromptInput` 仍超过 400 行参考线；本轮只把附件编排拆到 hook/bar，输入历史、选区和命令面板仍共处一个文件，后续若继续增长需单独拆分。
