# Note：面板"廉价感"修复——hover 减淡、去原生 tooltip（纸面层级方案被否决）

状态：已实施

## 问题

用户反馈笔记本面板"hover 阴影颜色难看，整个页面有廉价感"。诊断出两个落地的叠加来源与一个被否决的方案：

1. hover 令牌过重：`--hover-base: 0.2`（20% 灰罩在行上），约为 VS Code 浅色 hover（约 #e8e8e8 ≈ 8~10% 黑）的两倍，全应用共享该令牌，处处糊着重灰底。
2. 原生 title tooltip：目录树行带 `title={node.path}`，悬停即弹系统默认白框黑字气泡压在内容上，是最明显的"未设计"信号。
3. （候选方案）表面无层级：曾推断"侧栏/内容区/面板底同色"是廉价感来源，尝试给内容区铺纸面 `--paper`——**实机后被用户否决**（"正文这个背景丑死了，删掉"），已回退。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/tokens.css`（`--hover-base` 0.2 → 0.1）；`packages/ui/src/components/panels/workspace/DirectoryTree.tsx`（移除行级 title）、`DirectoryTree.css`（树行状态梯度）。`WorkspacePanel.css` 内容区背景保持透明（继承面板底）。
- UI 表面：全应用 hover 态统一减淡（悬浮条/面板/菜单/树行）；目录树 hover 与选中不再同色。无行为变化。

## 根因

两个独立来源叠加：交互态令牌 alpha 过重（`--hover-base: 0.2`，约为 VS Code 浅色 hover 的两倍）、目录行滥用原生 `title` tooltip。"内容区同色无层级"经实机证伪：内容区铺纸面反而显脏，用户明确否决。

## 决定

- 尺寸与状态一律在令牌层修，不逐组件覆盖：hover 减淡改 `--hover-base`，树行梯度复用既有 `--field`/`--hover` 两档。
- 可发现性优先级：行级路径提示（噪声）删除，图标按钮 tooltip（可发现性）保留。
- **工作区内容区不铺背景色**：预览/编辑区与面板同底，docx/pdf 的白纸由内容自身承载对比。

## 修复

- **hover 全局减到 10%**：`--hover-base: 0.1`。hover 只做轻扫，选中态才允许更重一档；fade 合成层的 0.08 下限保留（低透明度下 hover 仍可见）。
- **树行状态梯度**：hover 用 `--field`（5%），选中用 `--hover`（10%）——选中恒比 hover 重一档，禁止复制同色。
- **移除目录行 `title={node.path}`**：完整路径提示是低价值高频噪声；文件打开后由内容区承载信息。图标按钮（收起/展开等）的 tooltip 保留（可发现性）。

## 曾考虑的替代方案

- **内容区铺 `--paper` 纸面拉开表面层级：** 令牌注释里"面板 #F2F2F7 与纸面 #FBFBFD 差一档"的设计在实机上被用户直接否决（内容区大面积近白底显脏）；`--paper` 回退到只服务反色前景（`--on-ink`）等既有用途。重新引入条件：有明确的内容/ Chrome 分层需求且经用户确认。
- **只给目录树行单独减淡、不动全局 `--hover`：** 廉价感是全页性的，局部修会让 hover 浓淡在面板间不一致；既然令牌是唯一自由度，就在令牌上修。
- **自绘 tooltip 组件替代原生 title：** 引入一套浮层定位/延迟逻辑只为文件路径提示，收益配不上复杂度；直接移除行级 title 更符合防御预算。

## 后果与防回退

- 约束一：`--hover-base` 保持 0.1 档，任何"hover 不明显"的问题都不允许回调大 alpha，加 `--field-strong` 一档解决。
- 约束二：树行三态梯度固定为 hover `--field` < 选中 `--hover`，新列表类组件沿用同一梯度。
- 约束三：目录树行不再挂 `title`；需要路径提示时先问是否有比原生 tooltip 更好的承载（如状态栏）。
- 约束四：工作区内容区保持透明底；给任何内容区铺大面积背景色前必须实机确认。

## 验证

- `vitest run test/themeCss.test.ts test/workspace.test.tsx test/zoomablePreview.test.tsx` 23 例全过；biome 对改动文件无告警。
- 待实机验证：悬浮条/面板/树行 hover 呈轻灰扫过感；树行 hover 与选中可区分；无原生 tooltip 弹出；内容区无附加底色。
