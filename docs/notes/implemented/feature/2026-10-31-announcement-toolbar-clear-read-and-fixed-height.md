# Note：公告列表工具栏（全部已读 / 一次性清走已读）与面板定高滚动

状态：已实施

## 问题

用户继续审查公告中心，提出三点：

1. 面板"无限往下延长"——详情页正文超出面板高时没有独立滚动（`.announcement-detail` 是无约束块，被 `content-panel` 的 overflow:hidden 直接裁掉），列表滚动也欠约束，观感是面板随内容变高。
2. 要"一键已读"：逐条点开太慢。
3. 要"清除已读"：已读公告应能一次从列表清走；且所有操作必须是成熟 C 端控件（icon-only），禁止再出现文字按钮。

## 涉及范围

- 代码/模块：`AnnouncementList.tsx` / `AnnouncementList.css`（新增列表态工具栏与已读清除持久化；详情页与列表滚动约束）；渲染器 `localStorage`（沿用主题/静音模式的持久化先例，无新 IPC、无新 env）。
- 协议/服务器：不变。`MarkAnnouncementRead` 仍是逐条标记；批量与清走都是客户端编排。服务器侧没有"撤销已读"/批量/dismiss 能力（事实核查过 `channels/auth.ts`）。
- 相关 Note：[公告两级导航与打开即已读](2026-10-31-announcement-master-detail-and-read-on-open.md)——该 Note 曾把「全部标为已读」列为舍弃项（"通知密度低"），用户在本轮明确推翻：批量动作与清走是真实诉求；原 Note 的舍弃理由按本轮裁定作废。

## 决定

1. **列表态工具栏**：列表滚动容器之外、固定在顶部的行，右侧两个 icon-only 控件（`SurfaceButton` quiet 变体，25px 见方，与 `panel-close` 同一规格）：
   - `CheckCheck` 图标，`aria-label="全部标为已读"`：顺序调用 `onMarkRead` 清当批未读（快照遍历，逐条 await）；无未读或执行中禁用；失败把错误留在列表顶部并保留未读。
   - `Eraser` 图标，`aria-label="清除已读公告"`：把当前全部已读公告 id 记入"已清走"集合，立即从列表隐藏；无可见已读时禁用。一次性动作，无按压态。
2. **已清走集合落在渲染器 `localStorage`**（键 `answra:dismissed-announcements`，JSON 数字数组，损坏值忽略——与 theme.ts 覆盖键同一模式）：跨面板重开、跨应用重启都保持"清走"效果；新公告（新 id）照常出现。集合只增不减，体量可忽略；不做服务端同步、不按账户隔离（公告 id 为服务端全局序列，跨账户共享显示状态无害）。
3. **定高滚动**：列表态根 `.announcement-view` 与详情态根 `.announcement-detail` 都约束为 `flex:1 + min-height:0`；滚动只发生在 `.announcement-list`（列表）与 `.announcement-detail`（详情正文）内部。面板高度上限维持 `content-panel--settings` 的 560px，窗口不再随内容变高。
4. **控件约束延续**（上 Note 约束二的延伸）：工具栏动作一律 icon-only + tooltip，任何"文字按钮"不得回潮；空态、错误为文案节点（非控件）不受此限。

## 修复

- `AnnouncementList.tsx`：`dismissed` 集合状态（挂载时从 localStorage 注水，写入即持久化）、`markAllRead` 编排、`clearRead` 动作；列表改为「工具栏 + 滚动列表」两段。
- `AnnouncementList.css`：新增工具栏与容器滚动约束；详情页自身改为滚动容器，正文多元化排版不变。
- `themeCss.test.ts`：新增守卫——两段根容器的规则体必须含 `min-height: 0` 且滚动容器含 `overflow-y: auto`（防"面板延长"回潮）。

## 曾考虑的替代方案

- **「只看未读」开关：** 首轮推荐（可逆、零持久化）；用户在两案中拍板"一次性清走已读"。开关方案舍弃。
- **批量已读走新网关接口：** 舍弃。服务端契约不动，逐条顺序调用对公告量级（≤ 双位数）足够；真出现性能问题再议协议。
- **清走集合存主进程（新 IPC）：** 舍弃。纯渲染器列表偏好，localStorage 先例足够，不值得加一条进程边。
- **工具栏放滚动容器内 sticky：** 舍弃。外置固定行更简单，不发生"粘住时透出滚动内容"的问题。

## 后果与防回退

- 约束一：工具栏新动作必须 icon-only；新增文字控件按防腐化裁定阻断。
- 约束二：`clearRead` 只对 `readAt` 非空的条目生效；未读公告不允许被静默清走（信息不丢失）。
- 约束三：列表/详情两段根容器不得删掉 `min-height:0` 与滚动约束，themeCss 守卫持续生效。
- 约束四：键盘/并发路径上 `markAllRead` 与单条打开可共存（都归到 `onMarkRead` 逐条 IPC），失败语义是"当条中断，剩余未读保留"，不做部分回滚。

## 验证

- `packages/ui/test/AnnouncementList.test.tsx` 补：全部已读按钮对未读逐条调用、无未读禁用、清除已读把已读行移出列表且写 localStorage、空态禁用、动作后未读保留。
- `packages/ui/test/themeCss.test.ts` 补滚动约束守卫。
- 实机（用户目测）：公告页固定 560px 高，列表与详情各自滚动；「全部已读」一键清未读；「清除已读」后已读行消失、重启后仍清走；Tab 角标同步。
