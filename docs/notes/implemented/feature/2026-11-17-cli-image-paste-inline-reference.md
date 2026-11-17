# Note：CLI 图片粘贴改为输入框内联引用

状态：已实施

## 问题

CLI 输入框的图片附件原先是“独立附件条 + 独立读取状态行”：

- `PromptInput` 在空粘贴或 `Ctrl+V` 时同步等待 `readClipboard()`，读取期间 `AttachmentBar` 常驻显示“正在读取图片…”，Windows 冷启动 PowerShell 需要几百毫秒，输入区会持续抖动并多占一行。
- 图片列表与输入文本完全分离：`[Image #1] clipboard.png` 固定显示在输入框上方，常驻“空输入时 Backspace 删除最后一张图片”提示，删除只能靠空输入时的 Backspace，无法像普通文本那样在句子中定位删除某一张。
- 附件存的是整段 base64，随每次输入状态变化参与 React 渲染；超过 8 MB 直接报错，不做缩放。
- 读取失败或无图只能通过 `onPasteError` 冒泡到外层，提示位置与输入区不一致；`Ctrl+V` 在 Windows 终端通常被终端自身截获，应用层常常收不到按键。
- 输入框没有向终端声明逻辑光标位置，中文输入法的预编辑文本与候选窗只能落在渲染帧末尾，而不是真实打字位置。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/composer/imageReferences.ts`（新增）：`[Image #N]` 的格式化、解析、按引用解析附件、历史去引用与光标定位。
  - `apps/cli/src/tui/composer/usePromptAttachments.ts`：以引用 id 为键的附件表，负责读取、限量、按引用清理与 500ms 延迟读取状态。
  - `apps/cli/src/tui/composer/PromptInput.tsx`：粘贴路由、引用插入、引用级删除/左右跳过、提交映射、`Alt+V`、逻辑光标声明。
  - `apps/cli/src/tui/composer/TextInput.tsx`：把引用片段按主题色渲染为内联 chip，不改变字符宽度与光标布局。
  - `apps/cli/src/tui/composer/AttachmentBar.tsx`：删除。
  - `apps/cli/src/adapters/imageAttachmentReader.ts`：Windows 读取改为单次 `Get-Clipboard -Format Image`，超时 2s。
  - `apps/cli/src/image/path.ts`：新增 `parseImagePaste`，支持换行与空格分隔的混合粘贴。
- UI/进程/协议/持久化表面：
  - 只改 CLI 终端 UI；`ConversationSendRequest.images` 仍是 `{ name, dataUrl }`，协议、IPC、Agent 运行时与磁盘格式不变。
  - 图片只存在于当前输入会话内存；历史记录保存去掉引用后的文本，不恢复图片。
- 相关 Note：暂无直接相关记录。

## 决定

### 数据模型

- 输入文本持有引用标记 `[Image #N]`，编号从 1 单调递增，删除后不回填。
- 附件以 `id -> ImageAttachment` 存放；渲染、提交、历史都以文本中的引用为准，附件表只是被引用内容的容器。
- 未知或格式错误的引用按普通文本处理，不抛错、不吞掉用户内容；提交时只取仍被引用的附件，并按首次出现顺序发送。
- 历史记录保存前用 `stripImageReferences` 去掉引用标记，避免恢复出“有引用但没有图片”的悬空条目。

### 粘贴与读取

- 空粘贴异步读取剪贴板；图片路径粘贴支持换行与“空格 + 绝对路径”分隔，成功的图片转成引用，其余文本原样插入。
- 读取超过 500ms 才显示一行“正在读取图片…”，完成或失败立即消失；读取很快时全程没有中间态。失败通过既有 `onPasteError` 一次性提示。
- Windows 以 `Alt+V` 为主、`Ctrl+V` 保留兼容；其他平台保持 `Ctrl+V`。
- Windows 读取命令去掉重复的 `Add-Type System.Windows.Forms`，直接用 `Get-Clipboard -Format Image` 保存为 PNG，并释放图像对象。

### 编辑与渲染

- 引用是普通字符流的一部分：Backspace 在引用（含其后一个空格）结尾时整块删除，Delete 在引用开头时整块删除，左右方向键以引用为一步跳过。
- 引用被删到文本中不再出现时，对应附件在同一渲染周期内移除，不会出现“看不见但仍被发送”的图片。
- `TextInput` 用主题色渲染引用片段，宽度仍按字符数计算，选区与光标布局不变。
- 输入框通过 Ink 的 `useCursor` + `measureElement` 向终端声明逻辑光标位置：按输入框绝对坐标加上当前可视行列，把原生光标停在真实打字位置，供中文输入法放置预编辑文本与候选窗；密码输入或非活动状态隐藏原生光标。

### 明确不做

- 不做图片缩放、压缩或格式转换；仍超过 8 MB 拒绝。
- 不做图片预览、缩略图、点击打开或拖拽排序。
- 不做附件持久化、跨历史恢复或云端上传。
- 不改 `ConversationSendRequest` 协议，也不把 base64 换成文件路径。

## 影响表面

- 用户可见：粘贴后图片以 `[Image #N]` 直接出现在输入文本中，不再有独立附件条与常驻提示；只有慢读取才出现短暂状态行。
- 编辑：引用像普通文本一样可定位删除；删除最后一个引用即丢弃该图片。
- 发送：只发送仍被引用的图片；发送文本与输入文本一致，历史记录会自动去掉引用。
- 快捷键：Windows 新增 `Alt+V` 主路径，`Ctrl+V` 保留兼容。
- 输入法：原生光标停在打字位置，中文预编辑与候选窗跟随输入框，而不是渲染帧末尾。
- 无协议、IPC、持久化与 Agent 运行时变化。

## 曾考虑的替代方案

- **保留附件条，只优化文案与读取状态：** 舍弃。仍然存在“附件在上、文本在下”的双份状态，删除路径限制在空输入，不能解决 UI 割裂。
- **附件条与输入文本各存一份状态，提交时合并：** 舍弃。两处状态需要同步，容易产生“已删除但仍发送”或“文本引用不在列表”的不一致。
- **粘贴时先插入空 chip 占位，读取完成后再回填：** 舍弃。会出现无内容的中间 chip，失败时还要回滚，改为 500ms 阈值显示读取状态更简单。
- **常驻 PowerShell 子进程加速读取：** 舍弃本轮。需要管理生命周期、僵尸进程和异常恢复，收益只在频繁粘贴场景体现。
- **引用标记使用中文 `[图片 #N]`：** 舍弃。现有 `imageLabel` 与用户复制习惯都是 `[Image #N]`，改文案会增加宽度与识别分支。
- **把图片改为落盘后只传路径：** 舍弃。会改动共享协议与远端发送路径，超出本次输入体验范围。
- **只在读取完成后显示图片、不声明原生光标：** 舍弃。输入法预编辑与候选窗会继续落在渲染帧末尾，中文输入体验无法恢复。

## 后果与防回退

- 提交文本包含 `[Image #N]` 引用；下游若需要“纯文本”，必须调用 `stripImageReferences`，不得自行用正则删除，否则会漏掉重复引用与编号校验。
- 删除引用依赖 `referencedImageIds`；新增任何编辑入口时必须保证文本变更会触发 `prune`，不得只删附件表。
- 原生光标声明依赖 `measureElement` 的绝对坐标；输入框外层若新增 padding、边框或上方状态行，必须重新确认光标落点，不得改回“不声明光标”。
- 历史不恢复图片是明确取舍；如需恢复，必须同时设计附件持久化与引用编号映射，不能只把引用标记塞回输入框。

## 验证

- `pnpm --filter @answra/cli typecheck`
- `pnpm --filter @answra/cli test`：57 个测试文件、362 个测试通过，其中新增 `test/tui/composer/imageReferences.test.ts`，扩展 `test/image/path.test.ts` 与 `test/tui/composer/tui.composer.test.tsx`。
- `pnpm exec biome check` 覆盖改动文件。
- 实机验证：Windows PowerShell `Get-Clipboard -Format Image` 成功把剪贴板图片保存为 PNG，单次冷启动约 320–360ms；`test/tui/app/tui.render.test.tsx` 断言原生光标停在输入框 caret 列（5）。
