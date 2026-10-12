# Note：回复条悬浮展开实时对话

状态：已实施

## 问题

回复条用横向 ticker 展示当前运行活动，适合快速扫状态，但不适合连续阅读长文本、代码和多段回复。用户希望鼠标悬浮时展开同一轮对话的纵向面板，并看到模型正在生成的内容；展开不能重启请求、等待完成后再补内容，或依赖 ticker 的展示速度。

当前独立回复窗口由主 renderer 推送 `ReplyBarState`。该状态包含累计 `replyText` 和面向 ticker 的活动投影；主进程的会话增量通知目前只发给主窗口。若将 ticker 拉高或重复解析这份展示状态，会把面向单行摘要的协议继续扩展成 transcript，并在每个 token 上复制累计文本。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/shared/src/bridge.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`、`apps/desktop/src/main/replyBarWindowController.ts`、`packages/ui/src/app/ReplyBarWindowApp.tsx`、回复条窗口会话投影与展示组件。
- UI/进程/协议/持久化表面：独立回复条 `BrowserWindow`、只读会话 IPC、标准 `ConversationSnapshot` / `ConversationChange` 消费、revision 去重及回复条窗口尺寸/定位。模型 runtime、仓储和请求生命周期不变。
- 相关 Note：[回复条展示标准消息活动](../../implemented/feature/2026-10-12-reply-bar-stream-activities.md)、[后端拥有会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)、[回复工作流边界](../../implemented/architecture/2026-10-11-reply-workflow-boundary.md)。

## 决定

在现有独立回复条窗口内实现收起态与纵向展开态，不创建第二个模型请求，也不依赖主窗口的聊天面板。回复条仍负责紧凑活动预览；展开态负责当前会话的纵向消息阅读和实时呈现。鼠标进入回复条或展开面板时展开，离开整个窗口后收起；同时提供键盘可达的展开/固定入口和 Escape 收起行为，避免只支持 hover。

展开视图直接消费后端会话投影，而不是消费 `ReplyBarState.replyText`：回复窗口建立只读 `conversationId`，订阅 `onConversationChange`，加载 `getConversationSnapshot`，并用 `readConversationEvents(conversationId, afterRevision)` 补齐缺口。初始化先订阅并暂存通知，再读取 revision 为 R 的 snapshot，应用 R 之后的变更；所有变更按 revision 去重，发现缺号时从后端补读。首次展开可按 snapshot 恢复已生成前缀，之后只追加标准事件；流式结束只更新终态，不重新拉取、排序完整历史。

需要调整 main IPC 的访问边界：会话 snapshot、事件补读和 change 推送允许主窗口及受信任的回复条窗口；发送、取消、模型配置等写操作仍只允许主窗口。主进程把会话 change 同时推送给仍存活的两个 renderer。回复条窗口在前端只读，不获得新的会话写权限。

会话渲染从 `ConversationSnapshot.messages` 建立有序 transcript，以标准 `UIMessageChunk` 的 revision 增量更新活动 assistant 消息。AI SDK 的 reasoning/text 生命周期投影为独立块：reasoning 活跃时显示单一 shimmer 状态和其内容；首个文本块开始后思考块自动收起，答案作为独立 Markdown 块继续流式显示。回复窗口按 chunk id/kind 保序；相同文本/思考块的后续 delta 追加到原块，不扁平化成“所有思考在前、最终文本在后”。每个思考块仅折叠自己的正文，折叠后不保留固定占位高度，也不影响相邻文本块。普通文本采用 AICSS `TextResponse` 的正文/行内代码排版；活动输出使用起始于段落开头的单调 reveal 光标，后续累计文本只向末尾追加，不重播前缀。快照已有的文本立即完整展示，只对展开后到达的流式增量做轻微 reveal。思考内容采用 AICSS `Thinking + Reasoning` 的折叠标题和自然高度正文，由真实 reasoning 事件驱动，不复用其演示句子和延时定时器。reasoning 正文展开后参与外层 transcript 滚动，不创建嵌套滚动区；assistant 活动块紧邻排列，使思考摘要与最终文本保持连续。Markdown 在流式期间容忍未闭合代码围栏等不完整语法，完成后稳定渲染；代码块可复制，GFM 表格在受限宽度内横向滚动。对话区贴近底部时跟随文本和思考增量；读者向上滚动后暂停跟随，使用外层原生滚动查看历史，不显示悬浮跳转按钮。用户截图以紧凑预览呈现且不显示文件名。

展开与收起通过现有回复条窗口的 `fitReplyBar`/`ResizeObserver` 调整尺寸，保留同一个 HWND、捕获保护、主题和窗口生命周期。main controller 根据当前显示器 work area 计算向上或向下展开及水平边界，固定回复条锚点，避免扩展时窗口跳动或超出屏幕；展开高度受 work area 限制，内容区内部纵向滚动。

## 影响表面

- 回复条窗口：增加 hover 展开、纵向消息视图、键盘展开/固定和收起行为；收起态 ticker 视觉与现有速度策略保持独立。
- 对话显示：展示本轮用户文本/图片、assistant 文本、思考、工具与错误事件；assistant 块按 SDK chunk id/kind 保序渲染，相同块增量追加。reasoning 活跃时只显示一个思考状态；文本块开始后思考块自动折叠，最终答案保持独立并继续流式。每个 reasoning 折叠仅作用于自身内容，折叠不保留空白高度；展开正文进入外层 transcript 滚动流，不创建内层滚动条。正文和行内代码使用 AICSS `TextResponse` 层级。流式文本的显示游标从段落开头单调前进，新增增量接在末尾，不重置已展示前缀。贴底时自动跟随文本和思考内容增长，向上浏览历史时保持当前位置，不显示悬浮跳转按钮；用户截图使用紧凑预览且不显示附件名。
- 进程与协议：扩展 renderer sender 校验和 change 广播目标；仅开放回复窗口所需的读取权限，写操作仍限主窗口。继续使用既有 `conversationId`、`revision`、AI SDK `UIMessageChunk` 和仓储，不新增平行事件格式。
- 会话能力：只显示现有会话 snapshot 与事件，不改变当前单轮模型上下文、内存仓储生命周期、SQLite 计划或应用重启恢复能力。
- AICSS：适配 `Thinking + Reasoning` 的折叠布局与滚动视觉，但使用 Answra 主题令牌和事件文本；不复制内置静态演示句子及定时器。借鉴 `TextResponse` 的正文层级、`CodeBlock` 的代码块组织和 `ThinkingState` 的思考提示。不要直接采用 `StreamingText` 作为真实流式组件，它对累计文本变化会重置定时 reveal。AICSS 组件也不提供 Markdown 解析。首选本地适配所需样式/组件，不把 AICSS 主题变量直接覆盖到当前主题系统；若采用其源代码，保留 MIT 许可声明。Markdown renderer 依赖需在实施时单独确认和加入。

## 模块边界

- `apps/app` / `ConversationStore`：继续作为会话 transcript、revision 和标准事件的唯一权威来源，不知道悬浮面板或 markdown。
- `apps/desktop/src/main/conversation`：继续转发仓储快照和 change；`conversationIpc.ts` 对主窗口、回复条窗口分别实施只读/读写授权，并将 change 广播到两个受信任窗口。
- `packages/shared`：复用现有 snapshot/change 结构；如确需标识回复条视图会话，只添加最小只读查询类型，不加入 UI 样式或 markdown 数据。
- `packages/ui`：提取可复用的 revision 驱动会话投影，使回复条展开视图从后端快照和事件恢复；视图组件只负责事件分类、Markdown 呈现、滚动跟随和收起/展开交互。
- main reply window controller：拥有 BrowserWindow 展开尺寸、锚点和 work area 定位；renderer 上报测量结果，不自行操作 Electron。
- `useChat`：保留在现有发送工作流中，不让第二个 renderer 发送同一轮消息，也不把第二份 `useChat` transcript 作为权威状态。展开视图是后端 transcript 的只读 UI 投影。

## 曾考虑的替代方案

- **把回复条窗口的 `ReplyBarState` 扩成完整 transcript 并在每个 chunk 重发：** 可较快复用现有 IPC，但累计文本和历史图片会随每次增量重复序列化，并形成第二套面向 UI 的会话传输协议；仓储已有 snapshot/change 接口，因此舍弃。
- **展开时从 ticker 活动拼接消息：** 活动投影会合并或省略部分 chunk 语义，且没有可靠用户消息/会话 revision，不能负责 transcript 恢复和去重；因此只保留作收起态摘要。
- **创建新的 BrowserWindow 或把内容渲染进主窗口：** 新窗口增加生命周期、捕获保护和同步对象；主窗口路径会与独立回复窗口的安全/布局边界耦合。现有窗口可测量并 resize，因此在同一 HWND 内展开。
- **直接使用 AICSS `StreamingText`：** 其 reveal timer 对每次变化的累计文本重新从头播放，真实 token 流时会反复重播旧前缀并落后于模型；因此采用直接文本增量与可访问的光标/状态提示，借鉴其 CSS 视觉而不使用定时 reveal。

## 验收标准

- 可观察结果：鼠标悬浮或键盘展开后立即看到当前轮已有内容，后续文本/思考/工具事件持续出现；收起再展开无重复、丢失或重排；新到达的文本按轻微 reveal 速度可读，快照已有文本不重播。贴底时新文本和 reasoning 增量自动追踪到底部；用户向上查看历史时保持当前位置，使用外层原生滚动回看。
- 状态恢复：先订阅后取 snapshot 的竞态、重复 revision、缺失 revision、活动 run 中展开、窗口 renderer 重载和完成后展开均能恢复到同一 transcript。
- 权限：回复条窗口可读 snapshot/change 和补读事件；不能调用发送、取消、配置等写接口。主窗口行为维持现状。
- 布局：展开锚点稳定；靠近显示器上下左右边缘时选择可用方向并受 work area 限制；长回复只滚动内容区，窗口不会持续增高。
- 自动化验证：shared/UI 测试覆盖 revision reducer、snapshot 与增量交错、实时长文本、markdown 未闭合围栏、表格溢出、滚动跟随暂停/恢复、键盘展开；desktop 测试覆盖 sender 授权、双 renderer change 广播与定位尺寸边界；通过 `pnpm notes:check` 和 `pnpm verify`。
- 需要的实机验证：Windows 多显示器与屏幕边缘定位、展开时鼠标轨迹、滚动/选中文本、隐身捕获保护、透明度与浅色/深色/变色龙主题。

## 后果与防回退

- 回复窗口访问仓储读取接口会扩大 IPC 可读面；必须保持 sender 精确校验和只读授权，不得因方便而把整个回复窗口加入所有会话写接口白名单。
- 初始化和 change 通知可能交错；revision 缺号必须补读，不能用消息数组长度或时间戳替代 revision。
- 图片 data URL 在 snapshot 中可能较大；当前仓储已有该数据形态，实施时应避免每个 token 重发图片，并关注首次展开的复制/解码开销。
- Markdown 在流式中间态可能暂时改变解析结构；完成前允许尾部代码围栏/列表/表格呈现不完整，不能为追求最终排版而缓存整段到结束后才显示。
- 单轮模型上下文和 worker 生命周期内存限制保持不变；UI 展开不能暗示已支持持久化、多轮上下文或应用重启恢复。

## 验证

- 回复条 renderer 已通过只读 bridge 读取活动会话 snapshot、补读事件并订阅变更；连续 revision 增量更新消息，出现缺号时从事件日志恢复，快照和历史竞态会按 revision 去重。
- 主进程仅允许回复条 renderer 读取 `active-exam-conversation`；创建会话、发送、取消和模型配置仍要求主 renderer。会话变更同时广播到主窗口和存活的回复条窗口。
- 回复条同一窗口内支持 hover 展开、按钮固定/收起和 Escape；按内容测量窗口尺寸并计算上下展开方向，回复内容区独立滚动。
- AICSS 的 `TextResponse`、`CodeBlock`、`ThinkingState` 与 `Thinking + Reasoning` 布局作为视觉参考，在 Answra UI 包本地适配；reasoning 由真实事件驱动，不使用演示文本/定时器，也未使用会重播累计文本前缀的 `StreamingText`。reasoning 正文自然进入外层消息滚动流，不限高、不嵌套滚动。Markdown/GFM、代码块复制、表格横向滚动由本地回复组件负责。
- 对话面板的自动跟随更新键包含 assistant 文本和各类活动文本；贴底时滚动到最新，手动上翻后冻结当前位置，用户通过外层滚动区域回到底部后自动恢复跟随。
- 正文使用 14px/19px TextResponse 排版与行内代码底色；流式组件维护单调字符游标，文本 prop 增长时不会将显示长度重置为 0。快照首屏内容直接完整显示。
- assistant 文本和 reasoning 事件按块 id/kind 保持到达顺序；重复 delta 原位追加。折叠测试确认最终答案仍显示，思考块没有固定最小高度。
- 多思考块按 chunk id 独立聚合；工具调用按 `toolCallId` 和事件阶段隔离。不同类型的 React key 包含 kind 与 id；交错 reasoning 和多工具参数增量测试确认互不串写。
- reasoning 活跃时由思考块标题承载 shimmer，避免再叠加一个重复“正在思考”占位；出现 text delta 后自动收起思考块，答案仍是独立可见块。思考正文自然展开在对话流中，不能限高并另设滚动区；用户截图预览保持紧凑且不渲染文件名。
- 自动化证据：回复条交互测试 2 项通过；desktop 会话 IPC 与定位测试 6 项通过；全包类型检查、测试（124 项）和架构检查通过；本次变更文件 Biome 检查通过；`pnpm notes:check` 通过。
- 完整 `pnpm verify` 被未改动的 `apps/app/src/conversationRuntime.ts` 格式差异阻断，尚未通过全仓 lint。Windows 多显示器边缘定位、真实鼠标轨迹、选中文本与隐身捕获保护仍需桌面实机验证。
