# Note：悬浮条拉伸到面板宽度方案

状态：已拒绝：把悬浮导航条拉伸到固定面板宽度以制造"同一浮层"观感，会破坏悬浮条紧凑形态；用户裁定悬浮条宽度必须保持原样，宽度统一改为面板跟随导航栏。

## 问题

answer 安装包内固定宽度面板（480px）比悬浮条（约 307px）宽，两块浮层上下错位，需要恢复一致性。

## 涉及范围

- 当时的实现：`packages/ui/src/app/FloatingBarApp.tsx` 外壳挂 `data-panel-open`，`packages/ui/src/components/floating-bar/FloatingBar.css` 在面板打开期间把悬浮条栈 `align-self: stretch; width: auto`、胶囊 `width: auto` 并 `justify-content: space-between` 拉伸到面板宽度。
- 相关 Note：[所有面板宽度跟随悬浮导航栏](../../implemented/bug-fix/2026-11-01-panels-follow-floating-bar-width.md)、[answer Profile 设置面板宽度被视口钳制](../../implemented/bug-fix/2026-11-01-answer-panel-width-fit-content-clamp.md)。

## 提案

面板打开期间把胶囊拉伸到面板同宽，构成一个整体浮层；面板关闭后胶囊回到 `max-content` 紧凑态。宽度来源仍是面板固定 px，无 `vw` 参与，不触发 fit-content 宽度自引用。

## 影响表面

- 悬浮条形态：面板打开期间胶囊被拉伸至 496px（面板 480px + 外壳余量），关闭后回缩。
- 设置/笔记本/账户等固定宽度面板开合时的窗口整体形态。

## 曾考虑的替代方案

- **保留胶囊紧凑并把面板缩到导航栏宽度：** 已在尝试零代码改动时被搁置——担心笔记本正文在 307px 面板下被侧栏挤压到约 130px；重新评估后通过把侧栏硬下限从 170px 降到 132px 即可兼顾，最终在继任 Note 采用。
- **悬浮条常驻加宽到 480px：** 舍弃。无面板时也要为对齐付出屏幕空间，破坏紧凑胶囊产品形态，此前 [面板宽度 bug-fix Note](../../implemented/bug-fix/2026-11-01-answer-panel-width-fit-content-clamp.md) 已否决过同方向。
- **面板加 `min-width: var(--surface-w)` 只改对齐边：** 舍弃。宽度依旧不同，只是把错位方向换一边，不满足同宽诉求。

## 否决理由

- 悬浮条是常驻紧凑入口，"打开设置时胶囊凭空变宽、关闭再回缩"是用户明确不接受的行为（2026-11-01 实机裁定：悬浮条宽度必须保持原样）；宽度基准必须落在悬浮条一侧，而不是反过来。
- 拉伸态下胶囊内容靠 `space-between` 摊开填充，按钮间距与紧凑态不一致，同一控件两套密度，维护成本高且没有产品收益。

## 后果与防回退

- `[data-panel-open]` 拉伸规则与对应行为/CSS 守卫测试已全部移除；悬浮条在任何状态下保持 `max-content` 紧凑宽度。
- 继任方案：所有面板宽度统一跟随 `--surface-w`，见 [所有面板宽度跟随悬浮导航栏](../../implemented/bug-fix/2026-11-01-panels-follow-floating-bar-width.md)；未来若再出现面板与胶囊宽度体系分叉，禁用"拉伸悬浮条"方向，优先把宽度来源收敛到一项。
