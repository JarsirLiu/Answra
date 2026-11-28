# Note：TTS 设置简化为单一 provider（供应商下拉 + 品牌图标）

状态：已实施

## 问题

上一版把 TTS 设置做成了「provider 列表」：用户要先点「添加 provider」，再填 provider ID、显示名称、协议、端点、模型、音色与 Key；列表里还要再选一个「当前使用」。同时设置页暴露了「切句策略」二选一，并在表单下方展示预设来源文档与「尚未实机验证」说明。实际使用中暴露出三个问题：

1. **比同类设置重**：旁边的「模型」分组就是直接填端点/模型/Key，而语音合成却要维护一个命名实例列表；多数用户只用一个 TTS 服务。
2. **概念负担**：`provider ID`、`显示名称`、`协议`、`切句策略` 都是内部词汇，用户想的是「用 MiMo」。
3. **说明文字占据表单**：文档地址、未验证提示、Key 存储说明在窄面板里挤成多行，用户明确表示不需要。

目标：与「模型」分组一致的单一 provider 表单；供应商用带品牌图标的下拉选择；只保留用户真正要填的字段。

## 涉及范围

- 代码：`packages/shared/src/tts/{contracts,catalog}.ts`、`packages/config/src/{contracts,tts}.ts`、`apps/desktop/src/main/tts/{ttsSettingsStore,ttsService,ttsIpc}.ts`、`packages/ui/src/tts/{providerDraft,providerIcons,labels}.ts(x)`、`packages/ui/src/components/panels/{TtsSettingsGroup,TtsProviderForm}.tsx`、`SettingsPanel.css`
- 测试：`packages/shared/test/tts/*`、`packages/config/test/tts/config.test.ts`、`apps/desktop/test/tts/*`、`packages/ui/test/tts/*`
- 表面：设置 → 语音合成；`config.json` 的 `tts` 段；TTS IPC 载荷形状；keychain account 仍是 `tts-api-key:<providerId>`
- 相关 Note：`docs/notes/proposed/architecture/2026-11-28-tts-provider-architecture.md`、`docs/notes/proposed/feature/2026-11-27-interview-rehearsal-tts.md`

## 决定

### 1. 单一 provider，配置形状从列表改为单值

```ts
// packages/config/src/contracts.ts
export interface ClientTtsConfig {
  readonly provider: ClientTtsProviderConfig | null;
}

// packages/shared/src/tts/contracts.ts
export interface TtsSettingsView {
  readonly provider: TtsProviderConfig | null;
}

export interface TtsSettingsPatch {
  /** 整体替换；null 表示清除。 */
  readonly provider?: TtsProviderDraft | null;
}
```

旧配置 `tts.providers[] + activeProviderId` 在读取时迁移：优先取 `activeProviderId` 命中项，否则取第一项；`strategy` 与 `enabled` 字段直接忽略。显式 `provider: null` 优先于旧字段，表示用户已清除。

`provider.id` 仍保留（keychain account 后缀），但不再展示、不再由用户输入：目录厂商用目录 id，自定义固定为 `custom`。切换厂商时 id 变化，保存时 `syncCredential` 清理旧 id 的 Key，避免新旧 Key 串用。

### 2. 供应商下拉带品牌图标

`packages/shared/src/tts/catalog.ts` 仍是厂商唯一数据源（MiniMax / MiMo / OpenAI），新增 `packages/ui/src/tts/providerIcons.tsx`：

- MiniMax、MiMo（小米）、OpenAI 使用 opencode 仓库（MIT）的 provider SVG，转成内联组件，`fill="currentColor"` 跟随主题；
- 自定义项使用 lucide `SlidersHorizontal`；
- 图标只由目录 id 映射，未命中不猜测厂商。

下拉是表单内轻量浮层（button + `role="listbox"`），点击外部或按 Esc 收回；不引入全局浮层协调器。

### 3. 不再暴露切句策略

自动朗读固定 `sentence-pipeline`（边生成边读），手动朗读固定 `whole-text`（整段一次）。策略仍是 `@answra/tts` 的内部实现与 `TtsStrategyId` 类型的一部分，但 `tts` 配置、`TtsSettingsView` / `TtsSettingsPatch` 与设置页都不再出现该字段。

### 4. 去掉表单解释性文案，只保留获取 Key 的跳转

目录不再携带 `docsUrl` 与 `verification`；表单下方不再渲染「按官方文档填写，尚未实机验证」「Key 只保存在本机系统凭据库」等说明。字段标签已足以表达用途，验证状态留在 Note 与提交记录里，不占用设置面板。

目录新增 `apiKeyUrl`，API Key 字段右侧只显示一个「获取 API Key」文字链接，点击经 `window.answra.openExternal` 在系统浏览器打开厂商控制台；主进程只接受 `https:`。自定义厂商没有已知页面，不显示该链接。

### 5. 不再有「演练自动朗读」开关

保存了 provider 即视为用户要语音：演练模式自动朗读；没有 provider 时保持文字模式。自动朗读意图在没有 provider 时静默跳过，不把「未配置语音」当错误刷进聊天。手动朗读仍独立可用。

旧配置的 `enabled` 字段读取时忽略；用户要停用语音就清除 provider。

### 6. 表单行为

- 打开设置页直接显示表单；未配置时预填目录第一条（MiniMax），只需补 Key。
- 预设厂商不显示端点：端点、协议由目录固定，只有在「自定义」里才出现端点输入框与协议按钮，避免「选了 MiniMax 却把请求发到别的地址」。模型与音色仍是可调参数。
- MiniMax 没有服务端默认音色、`voice_id` 必传，目录给了一条官方系统音色作为默认值（用户可改）；MiMo 与 OpenAI 也各自带默认音色。
- 选具体厂商：覆盖协议/端点/模型/音色/显示名，清空已输入的 Key；同一厂商重复选中保持原样（不冲掉手改字段）。
- 选「自定义」：保留当前端点/模型作为起点，显示协议按钮；切协议只覆盖仍等于旧协议预设的字段。
- 已有 provider 时显示「清除」；Key 已保存时占位文案为「留空沿用已保存的 Key」，显式点「显示」才回读明文。
- 表单不再有「收起」「添加 provider」等列表操作。

## 影响表面

- 用户行为：设置页从「维护 provider 列表」变为「填一个 TTS 服务」；保存即启用语音，不再有总开关；切换厂商会清空 Key 并清理旧 Keychain 项。
- 持久化：`tts` 段结构变化，旧文件自动迁移；`strategy` 与 `enabled` 不再写盘。
- 协议/IPC：`TtsSettingsView` / `TtsSettingsPatch` 形状变化，preload 与 renderer 同步；新增 `window.answra.openExternal`（仅 https）用于打开厂商 Key 页面；音频帧、朗读意图与错误码不变。
- 计费：不变，仍由用户自己的 Key 直接请求厂商。

## 模块边界

- `packages/shared/src/tts/catalog.ts`：纯数据与类型，不含 UI、不联网。
- `packages/ui/src/tts/providerIcons.tsx`：只做目录 id → 图标映射；品牌商标归各厂商，仅用于标识服务商。
- `packages/ui/src/tts/providerDraft.ts`：纯投影函数，不 import React、不读写配置。
- `packages/ui/src/components/panels/TtsProviderForm.tsx`：表单与下拉交互；保存经父级回调。
- `packages/ui/src/components/panels/TtsSettingsGroup.tsx`：只持有视图、表单与保存流程。
- `packages/config/src/tts.ts`：负责旧列表格式迁移；不包含 Key、不访问网络。
- `apps/desktop/src/main/tts/*`：继续负责 keychain、合成与取消；不复制 UI 表单规则。

## 曾考虑的替代方案

- **保留多 provider 列表，只把「添加」改成表单直出：** 舍弃。列表、选中态、命名实例仍然存在，用户还是要理解 provider ID 与「当前使用」。
- **保留「切句策略」开关，默认边生成边读：** 舍弃。手动朗读本身就需要整段策略，暴露开关只会让用户误以为自动朗读也能整段；内部按来源固定策略更简单。
- **在供应商下拉里继续显示文档地址与验证状态：** 舍弃。用户明确不需要这类说明；验证状态改由 Note 与提交记录维护。
- **配置里存 `presetId` 运行时解析：** 舍弃，理由同上一版 Note：目录升级会改变已存配置的实际行为。
- **每个厂商一个图标包依赖：** 舍弃。只有三个图标，复制 opencode（MIT）的内联 SVG 比新增依赖更可控。

## 后果与防回退

- `tts.provider` 是唯一写入口：UI 测试锁住保存载荷为 `{ provider: {...具体值} }`，不出现 `providers` / `activeProviderId` / `presetId`。
- 旧配置仍可读：`config.test.ts` 覆盖「列表 + active」迁移与「显式 null 清除」。
- 切换厂商必须清 Key：`ttsSettingsStore.test.ts` 断言旧 id 的 keychain 项被删除、新 id 写入新 Key。
- 不再有策略 UI：`TtsSettingsGroup.test.tsx` 断言页面没有「切句策略」。
- 不再有总开关：`TtsSettingsGroup.test.tsx` 断言没有「演练自动朗读」控件；`ttsService.test.ts` 断言无 provider 时自动朗读静默跳过。
- 品牌图标只按目录 id 映射；新增厂商时补一条目录数据与一条图标映射，缺图标回退通用图标，不会崩溃。
- 预设厂商不得出现端点：`TtsProviderForm.test.tsx` 断言选中 MiMo 后没有「端点地址」输入框；切到「自定义」后才出现。端点值不得在预设模式下展示。
- API Key 链接只由目录 `apiKeyUrl` 提供；`TtsSettingsGroup.test.tsx` 断言点击后调用 `openExternal`，自定义模式不显示链接。
- 说明文字不得回到表单：`TtsProviderForm.test.tsx` 断言「尚未实机验证」「系统凭据库」文案不存在。

## 验证

- `packages/shared` 72 个测试、`packages/config` 21 个测试、`packages/ui` 396 个测试、`apps/desktop` 393 个测试（2 skipped）通过。
- `pnpm verify` 与 `pnpm notes:check` 通过。
