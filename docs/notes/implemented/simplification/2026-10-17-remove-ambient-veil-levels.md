# Note：移除「隐蔽强度」四档

状态：已实施

## 问题

「隐蔽强度」四档（贴合 1.4 / 隐蔽 2.0 / 均衡 3.0 / 清晰 4.5）按对比度目标把文字色往背景里混，用来实现「静置融底、远看不见」。实际使用中它产出的是一档比一档糊的灰字：

- 默认「隐蔽」档在浅灰底上解出约 `#ABABAB` 的文字色；
- 就算切到「清晰」档（4.5:1 ≈ `#6E6E6E`），再乘 `前景透明度` 85% 后实际只剩约 3.5:1；
- 用户反馈「这种糊的字，看着非常不舒服」，并明确「我觉得得切换颜色，而不是黑色、白色这种切换清晰度」。

也就是说：这个旋钮的四个档位里没有一个是他愿意看的，档位本身不成立。

## 涉及范围

- 代码/模块：`packages/ui/src/model.ts`（档位常量与文案）、`packages/ui/src/theme.ts`（`loadAmbientVeil` / `saveAmbientVeil` / `useAppTheme` 的 `ambientVeil` 选项）、`packages/ui/src/hooks/useAmbientTheme.ts`（`VEIL_PROFILES`、`chooseInk`、`chooseAccent`、对比度求解）、`packages/ui/src/components/panels/SettingsPanel.tsx` / `.css`（设置行）、`packages/ui/src/app/useAppearanceController.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/ImeCandidateWindowApp.tsx`。
- UI/进程/协议/持久化表面：设置面板少一行；localStorage 键 `answra-ambient-veil` 不再被读取（`useAppearanceController` 挂载时删除残留值）；不涉及 IPC 与主进程。
- 相关 Note：[变色龙只接管表面固有色](../feature/2026-10-17-ambient-surface-only-and-light-palette.md)、[变色龙隐蔽强度与表面融底](../feature/2026-10-17-ambient-veil-levels-and-blended-surface.md)（被本 Note 收缩）。

## 决定

彻底删除前景对比度分档：不再有档位常量、设置行、持久化读取，也不再有"按目标对比度求解文字色"的算法。前景可读性回归两件事：`[data-theme]` 调色板的实色（浅字/深字随背景亮度切换）与 `前景透明度`。变色龙的 `data-theme` 深浅切换与滞回带保留。

## 移除内容

- `AMBIENT_VEIL_LEVELS` / `AmbientVeilLevel` / `DEFAULT_AMBIENT_VEIL` / `AMBIENT_VEIL_LABELS` / `AMBIENT_VEIL_HINTS`：档位定义与文案。
- `VEIL_PROFILES`：四档对比度目标、强调色降饱和混比、激活底 alpha。
- `chooseInk` / `chooseAccent` / `solveInk` / `contrastRatio`：按目标对比度向黑/白求解文字色与强调色的整套逻辑。
- `theme.ts` 的 `isAmbientVeilLevel` / `loadAmbientVeil` / `saveAmbientVeil`、`useAppTheme` 的 `ambientVeil` 选项与"切档立即重推导"的 effect。
- 设置面板「隐蔽强度」设置行、`.setting-veil*` 样式、`useAppearanceController` 的档位状态与 setter、两个独立窗口的档位读取。

`AMBIENT_VEIL_STORAGE_KEY` 常量保留：仅用于在启动时删除历史残留值，不参与任何读取。

## 重新引入条件

任何"可见度/显眼程度"的分级只能在**表面与投影**上做，例如：

- 表面固有色在"背景原色 ↔ 调色板纸色"之间取值（贴合背景 ↔ 明确浮起）；
- 投影 alpha / 模糊半径分级。

不得再让分级改动**文字与图标颜色**：低对比灰字在 11–13px 中文上的可读性代价远大于它带来的隐蔽收益，这是本 Note 记录的真实教训。若要重新引入文字分级，必须先给出"浅底灰字不糊"的实证（截图对比 + 可读性验证）并更新本 Note。

## 曾考虑的替代方案

- **把四档的下限抬到 7:1 以上：** 已经接近纯实色的可读性，档位之间的差别只剩"有点灰"和"很黑"，旋钮失去意义（表面跟随 + 深浅调色板已经覆盖需求）。
- **只删掉默认档、保留"清晰"与"贴合"两档：** 用户实测连"清晰"档都不愿看，保留任何一档都会再次触发同一反馈。
- **把档位改名为"表面融合强度"并让它只调表面/投影：** 本轮不需要这个旋钮（表面跟随已能满足"贴合背景"），先删掉避免死控件；将来需要时按上面的"重新引入条件"重做。
- **保留档位但默认改成"清晰"：** 只把默认观感换个位置，其它三个档位仍是灰字陷阱，问题照旧。

## 后果与防回退

- 前景只能通过 `前景透明度`（`--fade`）整体淡化；没有"按对比度分档"的第二条路径。
- 设置面板的常规组只剩：跟随背景色、前景透明度、会议隐身；新增外观项时不得再引入"文字可见度"类旋钮而不更新本 Note。
- `answra-ambient-veil` 键不再被读取；若将来重新使用同名键，必须先读回并迁移旧值语义（旧值是档位字符串，新值语义不同，不能直接兼容）。
- 变色龙仍保留 `data-theme` 深浅切换与滞回带：那是"换调色板"，不是"调清晰度"，不要一起删掉。

## 验证

- `packages/ui/test/FloatingBarApp.test.tsx`：断言设置面板不再有「隐蔽」「贴合」按钮，`前景透明度` 滑块仍在。
- `packages/ui/test/useAmbientTheme.test.tsx`：断言派生函数只输出表面三键，不再出现任何对比度求解结果。
- `packages/ui/test/theme.test.tsx`：断言删除档位偏好后，`useAppTheme` 只按 `ambientFollow` + `colorGroups` 写入令牌。
- `packages/ui` 全部 206 个测试通过；`pnpm verify` 通过。
