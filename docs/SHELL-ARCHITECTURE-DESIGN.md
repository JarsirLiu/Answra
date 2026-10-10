# 悬浮壳架构演进方案

状态：设计提案，供审查。现有交互描述见 `FLOATING-BAR-INTERACTION.md`，本文记录架构层的问题、决策与方案。

## 问题：胶囊过大

现状：窗口固定 780px 宽（`main.cjs`），`.floating-bar` 撑满窗口，胶囊远大于内容实际宽度。根因是窗口尺寸由主进程按面板模式查表（`windowHeights`），而非由内容决定。

## 决策一：窗口尺寸跟随内容

- 渲染器用 ResizeObserver 测量胶囊根节点，IPC 上报尺寸。
- 主进程按上报值 resize，以当前窗口位置为锚，clamp 到 workArea。
- 移除 `minWidth` / `body min-width` / 固定 padding。
- 尺寸契约放 `packages/shared`，主进程与渲染器共用。

## 决策二：胶囊分段架构

胶囊按 Segment 分区渲染，段是挂载区，不是写死结构：

- 第一段：模式选择。
- 第二段：当前模式的功能入口。
- 第三段：常驻工具（笔记、资料、设置、关闭）。
- 第四段：AI 消息滚动段（ticker），被动订阅最新 AI 回复，隐蔽展示。

功能统一进 FeatureRegistry：

```ts
type FeatureDef = {
  id: string;
  segment: "mode-feature" | "utility" | "ticker";
  icon: ComponentType;
  surface?: SurfaceId;   // 打开的面板
  command?: string;      // 直接命令，如选文件
  perMode?: Record<Mode, boolean>;
};
```

ticker 段附加行为：空闲时收缩为小点或隐藏；点击打开 Chat Surface；播放完停留数秒后淡出。

## 决策三：Surface 统一协议

Shell 状态机：

```text
ShellState = { kind: "capsule" }
           | { kind: "surface", surfaceId: SurfaceId }
```

- 同一时刻至多一个 Capsule Surface；入口点击、ESC、关闭按钮均走同一 `closeSurface()`。
- SurfaceHost 承担打开/关闭动画、定位（胶囊下方，同窗口天然跟随拖动）、焦点管理。
- 对话、笔记、资料、设置全部是 Surface；同一 Surface 可被多个入口指向。

Capsule Surface 用单窗口模型（胶囊 + 面板一体）：跟随拖动天然同步、可做联合动画。

## 决策四：Spot Surface（点位即时响应）

需求：截图提问后，在截图位置附近出现小型响应 UI，消息从这里发；AI 回复以匀速滚动方式在此播放，完整、可慢慢阅读、不截断。

模型：

```text
SurfaceKind = "capsule-anchored" | "spot"
SpotSession = { anchor: 屏幕坐标, 播放策略, 会话状态 }
```

- Spot Surface 用独立轻量 BrowserWindow（无边框、透明、置顶、`showInactive`），按需创建销毁；胶囊窗不动。
- 原型期限定同时至多 1 个 Spot 会话，新提问替换旧的。
- 锚点抽象为通用坐标来源，截图只是第一种，未来可支持划词、选中文字。

### 双速播放

- 共享消息缓冲只追加；Chat 面板按流式原速渲染，Spot ticker 维护自己的播放游标（队列 + 定时器，约 5-8 字/秒，标点停顿加倍），生成快于播放则排队。
- 播放游标属于视图层，不进数据层。
- ticker 点击可加速或展开完整气泡。

## 决策五：消息状态与广播

- 消息/笔记状态从 `App.tsx` 本地 state 提升为模块级 store（`useSyncExternalStore`）。
- 截图对话与普通对话在同一会话内；Spot 只是另一个 viewport，发送时携带当前会话 id，可选新建会话。
- AI 流式增量只推送一份到主进程 store，广播给所有窗口；各窗口是同一缓冲的订阅者，窗口间不直接同步。
- 注意两点：广播按增量（不重发整条消息）；消息 id 在回复开始时确定，后续增量挂 id。

## 决策六：后端技术栈（CopilotKit + Pi）

分工：

| 层 | 选型 | 职责 |
|---|---|---|
| UI 组件 | `@copilotkit/react-ui` | Chat 面板等对话组件 |
| 前端状态/协议 | `@copilotkit/react-core` | 会话状态、消息协议、headless hooks |
| 网关运行时 | `@copilotkit/runtime` | 内嵌 Electron 主进程的本地 Node 服务，协议转发 |
| Agent 运行时 | Pi（badlogic/pi-mono） | Agent 循环、工具调用、会话，跑在本地 |
| 翻译层 | 自写 Pi → AG-UI 桥 | CopilotRuntime 与 Pi 之间的协议转换 |

关键认知：CopilotRuntime 是网关/BFF，不执行 Agent；Pi 负责真正的 Agent 循环。

数据流：

```text
React (react-core) ──AG-UI──▶ CopilotRuntime(主进程) ──AG-UI──▶ Agent 端点 ──▶ Pi
                                    │
                                    └── AG-UI 事件增量广播 ──▶ Chat 面板 / Spot ticker
```

Pi → AG-UI 映射（唯一翻译点，收在 agent-core 层）：

| Pi 事件 | AG-UI 事件 |
| --- | --- |
| run 开始/结束/出错 | `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` |
| 文本增量 | `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT`(delta 直通) → `TEXT_MESSAGE_END` |
| 工具调用 | `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` |
| 会话消息列表 | `MESSAGES_SNAPSHOT` |

要点：START 事件先声明 messageId/toolCallId；文本增量直通不缓冲重组。

选型说明：

- CopilotKit 负责前端 UI 与消息协议；Pi 负责后端 Agent 循环。
- Pi 生态有 `pi-web-ui`（Web 聊天组件）可直连 Pi 免翻译层，但成熟度低且前端绑死 Pi 数据模型，不作为基底；可作流式渲染参考实现。
- Pi 是单人维护项目，适配必须收在 agent-core 层，业务代码只感知 AG-UI，保证后端可替换。
- ticker 播放队列不用 react-ui（流式原速直渲染），走 headless 订阅增量自绘。

## 实施顺序

1. 窗口尺寸跟随内容（`window:fit` IPC）。
2. `App.tsx` 拆分：FloatingCapsule、SurfaceHost、各 Surface、FeatureRegistry。
3. 消息状态提升 store。
4. 新增 ticker 段。
5. Spot 窗口管理器 + Spot 会话 + 双速播放。
6. 主进程内嵌 CopilotRuntime + Pi agent-core（含 AG-UI 桥），替换演示回复。

## 已知风险

- 双窗口状态同步：原型用单 Spot 会话降低复杂度。
- Spot 窗不抢焦点（`showInactive` + 按需 focus），Windows 上与全屏应用的置顶关系需实测。
- 截屏涉及区域选择、采集状态提示、权限与错误处理，实现前需补充到交互文档。
- Pi 单人维护、API 可能变动；CopilotRuntime 与 Pi 版本演进需锁定在适配层内消化。
