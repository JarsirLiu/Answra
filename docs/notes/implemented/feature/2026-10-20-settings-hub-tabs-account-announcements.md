# Note：设置面板改为账户/设置/公告三入口面板，收敛悬浮条公告铃铛

状态：已实施

## 问题

用户看了设置面板后提出两点：设置面板承担的职责在变多（账户、模型、常规、公告散在两块面板里），希望「面板上方是不同的入口——账户、设置、公告这些」；同时悬浮条第三段（笔记本 + 公告铃铛 + 设置 + 关闭）随功能增加越来越挤，铃铛只在登录后才出现、无未读时是一个「哑按钮」，入口的价值密度低。原结构是两个并列的 480×560 面板：`SettingsPanel`（账户分组 + 模型 + 常规）与 `AnnouncementPanel`（独立公告面板，由悬浮条铃铛打开，`OverlayMode` 里有专用面板标识 `"announcements"`）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/SettingsPanel.tsx`（改为三 Tab 面板）、`PanelShell.tsx`/`PanelShell.css`（新增 `tabs`/`activeTab`/`onTabChange` 与 `.panel-tabs` 样式）、`AnnouncementList.tsx`/`AnnouncementList.css`（新组件，替代 `AnnouncementPanel`，删除原面板壳）、`packages/ui/src/components/floating-bar/WorkspaceControls.tsx` + `FloatingBar.tsx`（移除铃铛）、`packages/ui/src/app/FloatingBarApp.tsx`（装配与公告数据流）、`packages/shared/src/bridge.ts`（`OverlayMode` 去掉 `"announcements"`）。
- UI/进程/协议/持久化表面：悬浮条第三段入口与设置面板内部信息架构；`OverlayMode` 契约收窄（main 进程从未消费该字段，渲染器独占）；公告 IPC（`getAnnouncements`/`markAnnouncementRead`）与未读数据流不变。
- 相关 Note：[受保护的桌面公告中心](2026-10-17-desktop-announcement-center.md)（公告数据与未读状态来源）、[设置面板账户行收紧](2026-10-17-settings-account-row-compact-and-solid.md)（账户行视觉规范）、[悬浮条单一工作区入口](../simplification/2026-10-17-floating-bar-single-workspace-entry-and-icon-size.md)（第三段入口密度的既有先例）。

## 决定

- 设置面板**头部即 Tab 栏**（账户/设置/公告 + 右上角关闭钮），不再渲染标题行；原「标题行 + 下方 Tab」的双层结构是第一版实现，用户看过后认为上面多一层区域是浪费，收敛为单层。
- 「设置」页 = **常规在上、模型在下**（高频开关更易触达）；「账户」页 = 原账户分组内容（去掉了回复 Tab 名重复的 `h2`），且仅当 `bridge.getAuthStatus` 存在才出现该 Tab（无账户能力不支持空壳入口）；「公告」页 = 内嵌公告列表，未登录时显示「登录账户后可查看公告。」，登录后渲染列表。
- 未读角标从悬浮条铃铛迁到「公告」Tab 上（`PanelTab.badge`，超 9 显示 `9+`），未读信号不因入口收敛而丢失。
- 删除悬浮条铃铛按钮与 `.announcement-count` 样式；`Panel`/`OverlayMode` 中的 `"announcements"` 面板标识与 `PanelShell` 的 `--announcements` 变体一并移除。
- **导航类选中态统一改中性灰阶**（`--field-strong` 填充 + `--ink` 前景）：面板 Tab、未读角标、支持Tab变体、模型来源分段选中段、悬浮条图标按钮的持续激活态均不再用薄荷绿；薄荷绿收敛为「主操作按钮 + 额度进度」专用语义，同一位置不再出现两套强调色块（第一版 Tab 沿用了分段控件的薄荷实底，用户要求更统一的图标风格）。

## 曾考虑的替代方案

- **Tab 行取代标题行（只有一行 Tab + 关闭钮）：** 用户明确选择「目前的设置面板改成多个 tab……标题+Tab」，保留标题行让面板仍具名、与「笔记本 / 资料」等其他面板的头部一致；纯粹只有 Tab 的头部 abandoned。
- **Tab 状态提升进 `surfaceState`（新增 `"account"` 等 panel id）：** 会让 `OverlayMode` 反向膨胀，且 Tab 切换本质是面板内部的信息组织而非悬浮框表面切换（`panel` 决定外壳、面板内状态决定内容的既有正交原则）；舍弃。
- **公告 Tab 仅登录后可见（沿用铃铛登录前置逻辑）：** 未登录用户在设置里找不到公告入口会以为没有此功能；改为始终显示并给出登录提示，把能力边界显式说清。
- **保留独立 `AnnouncementPanel` 并同时存在两份入口：** 两个入口渲染同一份数据但壳/宽度不同，浪费维护成本且用户看过后认为重复；删除独立面板。

## 影响表面

- 悬浮条第三段为三个按钮：笔记本、设置、关闭应用；铃铛及其角标不再出现。
- 设置面板打开默认「设置」页，头部就是入口 Tab（无账户能力时两个）+ 关闭钮，没有独立标题行；面板 `aria-label` 仍跟随激活项。
- 「设置」页常规组在前、模型组在后；模型来源切换的两段选中态与 Tab 一样用中性灰阶填充。
- 公告列表、未读「未读/重要」标识、标记已读交互原样保留，仅外壳从独立面板变为设置面板 Tab 页。

## 后果与防回退

- 悬浮条不再有公告快捷直达：公告入口唯一路径是 设置 → 公告 Tab；除非用户重新提出加回，不得在第三段恢复铃铛（重复入口是本次收敛的对象）。
- 新的面板入口一律通过 `PanelShell` 的 `tabs` 参数挂 Tab 栏，Tab 栏即面板头部；带 Tab 的面板不得再渲染标题行（双层头部是用户明确否定的第一版）。
- 导航/选中/激活类状态用中性灰阶（`--field-strong`），薄荷绿只允许「主操作按钮 + 额度进度」两类语义；不得再把薄荷实底加回到 Tab、分段控件选中段或悬浮条激活态。
- `OverlayMode` 不得为面板内部的组织态重新添加成员；内部信息组织走面板自持状态（先例：工作区面板的选中文件）。
- 回归测试：`SettingsPanelTabs.test.tsx`（Tab 显隐/切换/角标/未登录提示 + 无标题行断言）、`WorkspaceControls.test.tsx`（第三段无铃铛）、`AnnouncementList.test.tsx`（列表行为原样）、`FloatingBarApp.test.tsx`（无标题行 + 登录/退出/额度流程改走「账户」Tab + 常规在模型之前的分组顺序）。

## 验证

- `packages/ui` 全量测试通过（SettingsPanelTabs 5 项、FloatingBarApp 相关用例改走 Tab 断言后 47 项全过；全包 vitest 在 `pnpm verify` 中复核）。
- `pnpm -r typecheck` 通过（`OverlayMode` 收窄后 ui/shared 无残留引用）；biome 对 `packages/ui`、`packages/shared` 0 错误。
- `pnpm verify` 全绿：biome + 全包 typecheck + vitest（ui 247+ / desktop 276）+ 架构守护通过；`pnpm notes:check` 通过。
