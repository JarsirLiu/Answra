# Note：账户页重写为卡片版式

状态：已实施

## 问题

用户打开「设置 → 账户」后反馈"我的账户面板好丑，能帮我删了重写吗"。旧版是 [档位徽章 Note](2026-10-24-settings-account-plan-badge.md) 落地的三段式（身份头 + 额度区 + 动作行），版式语言是"细分隔线切段 + 裸行文字"，具体问题：

1. **半屏空白**：面板固定 560px 高（`content-panel--settings`），账户内容只占上半，退出登录是悬在面板中段的孤立红色文字，下面是一整片空面板。
2. **没有结构**：身份、额度、动作全靠 1px 发丝线分段，没有表面分组，观感是"一串碎行"。
3. **层级拉不开**：`tokens.css` 里 `--ink-soft/--muted/--faint` 与 `--ink` 同色同透明度，字号又只有四档令牌，卡片内没有"更弱一档"的次级文字可用，标题/数值/说明看起来一样重。
4. **顺带发现的真缺陷**：`Badge.tsx` 从不 `import "./Badge.css"`，`styles.css` 也没聚合它，`.badge-control` 药丸样式从未加载——档位徽章实际渲染成无样式纯文本，进一步加重"没有设计"的观感。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/AccountPanel.tsx` + `AccountPanel.css`（新增，账户页独立组件）；`SettingsPanel.tsx`（账户 tab 改为挂载 `AccountPanel`，删除 `accountIdentity`/`planBadge` 与账户页 JSX）；`SettingsPanel.css`（删除 `.account-*`、`.setting-quota*` 规则）；`PanelShell.tsx`/`PanelShell.css`（新增 `account` 变体）；`packages/ui/src/components/controls/Badge.tsx`（补样式导入）；`packages/ui/src/styles.css`（聚合 `AccountPanel.css`）。
- UI 表面：设置面板「账户」tab 的信息结构、文案粒度与面板高度；全应用档位徽章（样式修复后由纯文本变药丸）。
- 相关 Note：[档位徽章](2026-10-24-settings-account-plan-badge.md)、[统一额度展示](2026-10-23-unified-user-quota-display.md)、[额度细分样式缺陷](../bug-fix/2026-10-24-settings-quota-detail-styles.md)、[账户行紧凑化](2026-10-17-settings-account-row-compact-and-solid.md)。

## 决定

- **账户页独立成 `AccountPanel`**：`SettingsPanel` 只保留 tab 路由与登录/退出的异步逻辑（状态来源仍是 `bridge.getAuthStatus/onAuthStatus/loginAccount/logoutAccount`），账户页展示与样式随组件同置。
- **卡片版式取代分隔线分段**：资料卡（28px 头像圆标 + 邮箱/用户名 + 档位徽章贴其右侧）→ 额度卡（"额度"标签行 + 剩余天数、可用积分、6px 用量轨、明细行）→ 动作行。卡片 = `--field` 填充 + 10px 圆角、无描边，分组靠卡片与 10px 间距。
- **额度明细逐行列出**：标签在左、数值在右（`dl/dt/dd`），订阅档给"本周期已用 / 套餐到期"，免费档给"福利积分 / 账户额度 / 福利到期"；只列服务端额度摘要里真实存在的字段，缺失字段不出行、不补默认值。旧的单行小字串（"福利 10 · 账户额度 8 积分"）废弃。
- **面板高度随账户页收紧**：`PanelShell` 新增 `account` 变体（`height: auto` + `min-height: 0`），窗口由既有 `useFitContent` 跟随伸缩；设置/公告 tab 保持 560px 高度档不变。首版在此变体上挂了 vh 基准的 `max-height`，引发面板塌缩（根因与修复见 [vh 上限塌缩缺陷](../bug-fix/2026-10-24-account-panel-vh-max-height-collapse.md)）。
- **次级文字层级在账户页内用 `color-mix` 从 `--ink` 派生两级**（`--account-ink-soft/faint`，与 `--chat-meta` 同法）；不动全局 `--ink-soft` 令牌（那会影响全应用）。
- **徽章样式修复**：`Badge.tsx` 补 `import "./Badge.css"`，outline/solid 药丸才真正生效。
- 沿用既有约束不放松：徽章唯一来源是 `quota.kind/planName`；能力目录（`capabilities`）不进 UI；不放大数字；薄荷绿只给主操作；退出登录是警示色文字 + hover 淡警示底；头像固定 SVG 不拼首字母。

## 影响表面

- 账户 tab 文案粒度变化：`50 积分 · 剩余 42 天` 拆成 `50 积分` 与 `剩余 42 天`；`福利 10 · 账户额度 8 积分` 拆成两行；新增 `套餐到期` / `福利到期` 行。
- 面板高度行为变化：账户 tab 为短面板，切到设置/公告恢复 560px，窗口随之伸缩。
- 数据来源与 IPC 契约不变（`AuthStatus` / `AuthQuotaInfo`），main 侧拉取链路零改动。
- 全应用档位徽章由纯文本变为药丸（样式修复的影响面不限于账户页）。

## 曾考虑的替代方案

- **保持 560px 面板、只把内容垂直居中：** 不改窗口行为，但空白仍在，只是上下对称；用户抱怨的核心是"半屏空白 + 无结构"，居中不解决碎行问题，弃用。
- **额度卡拉伸填满面板、积分数值放大做焦点（钱包式大卡）：** 历史 Note 已明确否决"大数字"，卡片过大内容反而更空，弃用。
- **明细继续用一行小字串起（"福利 10 · 账户额度 8 积分"）：** 占位最少，但数值无法对齐、可读性差，且此前出过漏写该行字号回落默认值撑爆排版的缺陷（见 [额度细分样式缺陷](../bug-fix/2026-10-24-settings-quota-detail-styles.md)）；改为逐行 `dl`，弃用该形态。
- **徽章挪到邮箱下方独占一行：** [档位徽章 Note](2026-10-24-settings-account-plan-badge.md) 已因用户反馈"徽章不应独占次行"否决，维持贴邮箱右侧。
- **退出登录用 danger 实底大按钮：** 常驻警示色块过重；沿用既有决定（警示色文字 + hover 淡警示底），只加图标与整行排布，弃用实底。

## 后果与防回退

- 约束一：账户页新增信息块必须进卡片（资料卡/额度卡/明细行），禁止退回"裸行 + 细分隔线切段"的旧版式。
- 约束二：`content-panel--account` 只服务账户页；设置/公告保持 560px 高度档，不要把整套设置面板改成 auto 高（tab 切换会抖动）。账户变体禁止挂 vh 基准的 `max-height`/`height`（fit-content 窗口自引用，见 [塌缩缺陷](../bug-fix/2026-10-24-account-panel-vh-max-height-collapse.md)）。
- 约束三：次级文字层级用 `color-mix` 从 `--ink` 派生，不在组件里写死灰色字面量，也不改全局 `--ink-soft`。
- 约束四：额度明细只列服务端真实字段，缺失不出行、不补默认值；档位徽章唯一来源仍是 `quota.kind/planName`。
- 约束五：账户页字号只走四档令牌（`themeCss.test.ts` 的字号守卫已纳入 `AccountPanel.css`），不放大数字。
- 约束六：控件组件必须自带样式导入（`Badge.tsx` 教训：漏导入只会静默变成无样式，不会报错）；不依赖 `styles.css` 聚合兜底。

## 验证

- `packages/ui/test/SettingsPanelTabs.test.tsx`：免费档断言改为逐行明细（福利积分/账户额度/福利到期），新增 3 例——订阅档明细 + 用量轨（`aria-valuenow` 38）、无 quota 不渲染额度卡、未登录只有登录动作。
- `packages/ui/test/FloatingBarApp.test.tsx`：订阅档/免费档两例断言同步拆分为逐行文本，保留"不出现 ¥/余额/套餐/未开通套餐"的负向断言。
- `packages/ui/test/themeCss.test.ts`：字号守卫纳入 `AccountPanel.css`。
- 待本地执行：`pnpm verify`（lint + typecheck + vitest + 架构守护）与实机打开「设置 → 账户」查看卡片版式、徽章药丸与面板高度收紧效果；本轮改动未代跑门禁，结论以实跑为准。
