# Note：宿主无关的 TTS provider 架构（协议与厂商分离）

状态：提案

## 问题

演练模式需要让「面试官」发声（功能决策见 [面试演练模式语音合成](../feature/2026-11-27-interview-rehearsal-tts.md)），但仓库当前没有任何语音输出能力。落地前必须先回答三个架构问题：

1. **合成代码放哪一层**。放在 `apps/desktop/src/main` 最省事，但 `apps/cli` 将来也要支持语音（用户 2026-11-28 明确要求预留），Electron 专属目录无法复用。放在 `apps/agent` 又会让 Agent 运行时承担音频编解码与 HTTP provider 细节，职责污染且加大 utility process 产物。
2. **怎么支持多 provider**。只写一家会让第二家变成大改；写成一个大 switch 会让协议解析、厂商默认值、鉴权三件事缠在一起，团队无法并行。
3. **凭证与播放归谁**。TTS Key 是用户自己的（BYO Key），必须留在 OS keychain；播放依赖宿主（renderer 用 Web Audio，CLI 将来用系统播放器），不能塞进合成库。

同时，云端暂不做 TTS 转发（用户 2026-11-27 决定），所以本架构不新增云端能力位、不依赖登录态。

## 涉及范围

- 代码/模块：
  - 新增 `packages/tts/`（Node-only 纯库）：协议 port、adapter、切句与 Markdown 净化、合成策略、注册表、错误归一。
  - `packages/shared/src/tts/`、`packages/shared/src/channels/tts.ts`：跨进程 DTO、协议与策略枚举、厂商预设。
  - `packages/config/src/tts.ts`：非 secret 的单一 provider、开关与旧配置迁移。
  - `packages/credentials/src/index.ts`：`tts-api-key:` account 前缀常量。
  - `apps/desktop/src/main/tts/`：设置存储、凭证注入、把文本增量攒成流交给 speaker、IPC、agent 意图桥。
  - `apps/agent/src/interview/tts/`：可朗读正文增量（仅演练），不切句。
  - `packages/ui/src/tts/`：播放、按 `messageId+sequence` 去重、队列、取消。
  - `apps/cli/src/speech/`：本提案**只预留边界，不实现**。
- UI/进程/协议/持久化表面：新增 `answra:tts:*` 频道；worker 事件新增 delta 形状的 `tts-speak`；`ClientConfig` 新增 `tts` 段（含 `strategy`）；音频字节只在 desktop main → renderer 传递，不写业务存储、不进 transcript。
- 相关 Note：
  - [面试演练模式语音合成](../feature/2026-11-27-interview-rehearsal-tts.md)
  - [面试演练与辅助双模式](../../implemented/feature/2026-11-27-interview-rehearsal-and-assist-modes.md)
  - [面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)

## 提案

### 1. 分层模型：协议 ≠ 厂商

- **协议（Protocol）**是 wire 格式，数量少且稳定：`minimax-native`、`openai-compatible`、`chat-audio`。每个协议一个 adapter 文件，只负责请求构造、鉴权头、响应解析（含 hex/Base64/二进制）与错误归一。
- **厂商（Provider）**是一条配置数据：`id` + `label` + `protocol` + `baseUrl` + `model` + `voice`。厂商预设是纯数据，不写代码。
- **厂商目录**（`packages/shared/src/tts/catalog.ts` 的 `TTS_PROVIDER_CATALOG`）是厂商预设的唯一数据源；新增 provider 时 UI 从这里取初值，`TTS_PROTOCOL_PRESETS` 也由它派生，不手写第二份。目录只是表单初值，保存后配置里是具体值（见 `docs/notes/implemented/feature/2026-11-28-tts-provider-settings.md`）。

扩展规则：

| 新增内容 | 改动 |
| --- | --- |
| 一家支持 OpenAI 兼容的厂商 | 在 `catalog.ts` 加一条预设数据 |
| 一种新 wire 格式（如 DashScope 原生） | 加一个 adapter 文件 + 注册表一行 + 枚举一个值 |
| 一家厂商的特殊参数 | 走 provider 级 `options`（非 secret），不污染协议 |

### 2. 新增 `packages/tts` 包（Node-only，宿主无关）

```text
packages/tts/
  src/
    contracts.ts        # TtsSynthesisRequest / Result / TtsProviderOptions
    port.ts             # TtsProviderPort（单请求）
    utterance.ts        # TtsUtterance（文本增量流）+ TtsSegmentAudio
    speaker.ts          # createTtsSpeaker：宿主唯一入口，返回 AsyncIterable
    errors.ts           # TtsProviderError、请求信号与错误归一
    chunk/
      split.ts          # 整段切分（现有 splitSpeechText）
      stream.ts         # 增量切句：push(delta) → 段；flush() → 尾段
      sanitize.ts       # 流式去 Markdown：未闭合时缓冲，超长兜底
    strategies/
      types.ts          # TtsStrategy 接口
      wholeText.ts      # 攒完再切、串行合成
      sentencePipeline.ts # 边收边切、有界并发、按序产出
      index.ts          # Record<TtsStrategyId, TtsStrategy>
    protocols/
      minimaxNative.ts  # POST /v1/t2a_v2，hex 解码，base_resp 错误检查
      openAiCompatible.ts # POST /audio/speech，二进制响应
      chatAudio.ts      # POST /chat/completions，assistant 文本 + Base64 音频
    registry.ts         # 协议注册表
    index.ts
    README.md
  test/
    protocols/minimaxNative.test.ts
    protocols/openAiCompatible.test.ts
    protocols/chatAudio.test.ts
    chunk/split.test.ts
    chunk/stream.test.ts
    chunk/sanitize.test.ts
    strategies/sentencePipeline.test.ts
    speaker.test.ts
    support/recordingFetch.ts
  package.json          # 只依赖 @answra/shared
  tsconfig.json
```

依赖方向：

```text
@answra/shared ← @answra/tts ← @answra/desktop(main)
                            ← @answra/cli（将来）
```

`@answra/tts` 不引入 `electron`、`node:` 内置、`@answra/agent`、`@answra/config`、`@answra/credentials`；`fetch` 通过 `TtsProviderOptions.fetch` 注入（默认 `globalThis.fetch`），测试用 mock 锁 wire 格式。

### 3. 契约分层：四份契约，各自变更成本

契约不是一份。按消费者拆成四份，变更成本从高到低递减：

| 契约 | 位置 | 装什么 | 谁消费 | 绝不能装 |
| --- | --- | --- | --- | --- |
| 跨进程契约 | `packages/shared/src/tts/` | 协议枚举、厂商目录、provider 配置视图、朗读意图、音频帧、错误码、能力声明 | desktop main / preload / renderer / CLI | wire 细节、hex、Key、音频文件路径 |
| 合成端口契约 | `packages/tts/src/port.ts` | `synthesize()` 输入输出、工厂签名、注入的 `fetch` | desktop main / 未来 CLI | Electron、config、keychain、环境变量 |
| 配置数据契约 | `packages/config/src/tts.ts` | 盘上非 secret 结构（开关、provider 列表） | desktop main / 未来 CLI | API Key、任何凭据 |
| 凭证命名契约 | `packages/credentials` | `tts-api-key:<providerId>` account 前缀 | desktop main / 未来 CLI | 协议知识、provider 默认值 |

两条设计原则：

1. **契约按消费者设计，不按实现者设计**。`shared` 那份必须稳定、可序列化、能被 preload 转发；`packages/tts` 那份可以有 `Uint8Array` / `AbortSignal` 这类运行时对象。两份不合并，否则 UI 会拿到它用不上的类型，adapter 又会引入它不需要的 IPC 约束。
2. **契约先落，adapter 后写**。A/B/C 三线都从 shared 契约与 mock adapter 出发，不等真实厂商联调。

### 4. 跨进程契约必含的九项语义

先定形状，再定语义。跨进程契约的主体形状：

```ts
export const TTS_PROTOCOLS = ["minimax-native", "openai-compatible", "chat-audio"] as const;
export type TtsProtocol = (typeof TTS_PROTOCOLS)[number];

/** 合成策略：切句时机与调度方式；与协议正交，属于 `@answra/tts` 内部实现。 */
export type TtsStrategyId = "whole-text" | "sentence-pipeline";

export const TTS_PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface TtsProviderConfig {
  id: string;                 // 必须匹配 TTS_PROVIDER_ID_PATTERN
  label: string;
  protocol: TtsProtocol;
  baseUrl: string;
  model: string;
  voice: string;
  hasApiKey: boolean;         // 视图字段，不是盘上数据
  capabilities: TtsProviderCapabilities;
}

export interface TtsSettingsView {
  enabled: boolean;
  /** 设置页只维护一个 provider；null 表示尚未配置。 */
  provider: TtsProviderConfig | null;
}
```

#### 4.1 输入：说什么

朗读意图是**文本增量**，不是一整段。这样「等全文再合成」与「边生成边读」只是策略差异，协议不需要再改第二次。

```ts
export interface TtsSpeakIntent {
  readonly conversationId: string;
  readonly messageId: string;
  /** 同一 messageId 内的增量序号，从 0 递增。 */
  readonly sequence: number;
  /** 本帧文本增量；整段模式就是最后一条带全文。 */
  readonly delta: string;
  /** 该 messageId 的文本是否已产出完毕。 */
  readonly final: boolean;
}
```

- **agent 只决定「哪些文本可读」**：只挑正文，不读工具调用、思维链、系统提示；它不切句、不判断并发、不知道阈值。
- **切句与 Markdown 净化归 `packages/tts`**：`**加粗**`、代码块可能跨增量，必须由流式 sanitizer 缓冲处理，不能逐帧删；这属于「怎么说」，不是领域策略。
- **单 delta 与多 delta 走同一条链路**：文本结算时发一条 `{ delta: 全文, final: true }` 即可先跑通；改成逐帧后协议不变。
- `conversationId` 由 agent 在落账处提供，desktop 用它做取消分代与音频帧归属；`source` 由宿主决定（agent 意图恒为 `auto`），不进意图契约。

#### 4.2 音色与参数：怎么说

参数分三类，判定标准是「两个以上协议都有的才提升为通用字段」：

| 类别 | 例子 | 落点 |
| --- | --- | --- |
| 通用 | `voice`、`speed`、`format` | 契约顶层字段 |
| 协议内 | MiniMax 的 `audio_setting.bitrate`、`emotion` | `TtsProviderOptions.options` |
| 厂商私有 | 某家的 `language_boost` | provider 预设数据里的 `options` |

反面案例是设计一个 `Record<string, unknown>` 万能参数树：看起来「支持一切」，实际把厂商差异藏了起来——UI 不知道该渲染哪些控件，也没有任何一层能做校验。**宁可不支持，也不要不可见的支持**。

#### 4.3 输出：拿到什么

```ts
/** adapter 单请求结果；不含 messageId / sequence。 */
export interface TtsSynthesisResult {
  readonly bytes: Uint8Array;
  /** 实际音频类型，由 adapter 按响应判定，不信任请求参数。 */
  readonly mimeType: string;
  /** 可选：用于播放进度；拿不到就不填，不估算。 */
  readonly durationMs?: number;
}

/** speaker 产出的段音频；sequence 由策略分配并保证递增。 */
export interface TtsSegmentAudio {
  readonly messageId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}
```

三条硬规定：

- **只给 bytes，不给 URL**。URL 会引入下载、过期、鉴权、临时目录一整套生命周期问题，还会把「合成」拆成两段失败面。
- **不给 hex / Base64 字符串**。编码是 wire 细节，在 adapter 内解码即止。
- **音频不落盘、不进 transcript、不进 agent**。

帧语义：**一条 assistant 消息对应一个帧组**（按 `messageId` 归组、`sequence` 排序）。speaker 保证按 `sequence` 递增产出，所以宿主只负责转发，UI 只负责顺序播放，**两端都不需要重排或缓冲乱序结果**。单帧字节设上限，防止超长文本一次塞进 IPC。

#### 4.4 错误：最容易做错的一项

对齐仓库既有 [远程错误契约](../../../../packages/shared/src/schema/remote/errors.ts) 的范式——稳定码给程序判断，文案只给人看：

```ts
export interface TtsFailure {
  code: TtsErrorCode;
  /** 面向用户的短说明；任何一层都不得用 message 做判断。 */
  message: string;
  /** 只表示调用方能否安全重试，不代表 provider 状态未变。 */
  retryable: boolean;
}
```

首版必须覆盖这些码，缺一个都会在线上退化成「静默失败」：

| code | 场景 | retryable | 为什么必须有 |
| --- | --- | --- | --- |
| `not-configured` | 未选 provider / 未填 Key | false | 要能引导去设置，而不是只报「失败」 |
| `unauthorized` | Key 错误或失效 | false | 与配额是两种修复动作 |
| `quota-exceeded` | 余额或额度不足 | false | 用户需充值，重试无意义 |
| `rate-limited` | 并发或频率限制 | true | 需要退避重试 |
| `invalid-request` | 参数不被接受 | false | 通常是配置写错 |
| `provider-rejected` | HTTP 200 但业务码非 0 | false | MiniMax 的坑；单独成类便于定位，不能混进 `network` |
| `network` | 链路失败 | true | 可重试 |
| `timeout` | 超过单段合成超时 | true | 与 `network` 分开，便于调阈值 |
| `aborted` | 用户取消或切模式 | false | **正常路径**，UI 不得弹错误提示 |
| `empty-audio` | 200 且音频为空 | false | 不拦会静默无声 |
| `unsupported-protocol` | 未知协议 | false | 显式失败，禁止静默降级 |
| `unsupported-strategy` | 未知合成策略 | false | 显式失败，禁止静默降级 |

禁止把 provider 原始响应体透传给 UI：既泄漏内部信息，也让文案不可控。原始信息只进 main 的日志，且必须剔除 Key。

#### 4.5 取消

`AbortSignal` 贯穿四份契约。取消必须能区分三种「没声音」：

- `aborted`：我们主动取消（切模式、新 run、用户点停止），静默处理；
- `network` / `timeout`：链路问题，可提示；
- `provider-rejected` / `unauthorized` / `quota-exceeded`：配置或账户问题，必须提示且指向设置。

三者 UI 表现完全不同，归一化时不能都压成一个 `failed`。

#### 4.6 能力声明

```ts
export interface TtsProviderCapabilities {
  streaming: boolean;
  formats: readonly string[];
  /** 单次请求字符上限；adapter 据此切句。 */
  maxChars: number;
  supportsSpeed: boolean;
  supportsEmotion: boolean;
  voiceCatalog: "static" | "remote" | "none";
}
```

不声明会怎样：UI 给所有 provider 都渲染「语速」「情感」控件，用户调了没反应；或者假设所有端点都支持 `response_format`，结果某家 400。**能力声明决定 UI 能渲染什么，不靠猜。**

预设数据里的 `capabilities` 必须与 adapter 自身常量一致，用单元测试锁住两边，避免预设说支持、adapter 实际不支持。

#### 4.7 身份与版本

- `providerId` 规则写进契约：`^[a-z0-9-]{1,32}$`。原因是它要拼进 keychain account（`tts-api-key:<providerId>`），不能含冒号、斜杠、中文或空格；非法值必须在保存时就拒绝，不能等到读 Key 才发现。
- 契约版本常量 `TTS_CONTRACT_VERSION`：**加字段兼容，改语义必须升版本**。音频帧一旦发出去就有兼容问题，字段含义变更必须能被识别和拒绝。

#### 4.8 去重与来源标记

```ts
export interface TtsAudioFrame {
  readonly messageId: string;
  /** 自动朗读归属会话；手动朗读为 null（不参与会话级取消）。 */
  readonly conversationId: string | null;
  /** auto 参与按 messageId+sequence 去重；manual 是用户主动行为，允许重播。 */
  readonly source: "auto" | "manual";
  readonly sequence: number;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}
```

`source` 是契约字段不是 UI 细节：snapshot 重放、流式 delta 重复触发时，只有 `auto` 需要去重；`manual` 若被吞掉，用户会以为按钮坏了。去重键是 `messageId + sequence`，不是只有 `messageId`——分段合成后同一条消息会有多帧。

#### 4.9 配置与凭证边界

- 盘上只存非 secret；`hasApiKey` 是**视图字段**，不是数据字段，不能写回配置。`enabled`、`provider`（含 `baseUrl`）都属于非 secret；自动/手动策略是运行时固定值，不写盘。
- `revealApiKey` 是独立动作，不能混进 `getSettings`；渲染层默认拿不到明文。
- Key 缺失时 fail-closed，不回退明文、不回退其它 account。

#### 4.10 边界：不该进契约的东西

`apiKey`、provider 原始响应体、音频文件路径、agent 的 prompt、desktop 平台能力、云端能力位（`DesktopCapability`）、模型与音色列表缓存。

#### 4.11 纪律：并行开发的契约规则

1. **只加不改**：新增协议或厂商不改已有字段，否则 A/B/C 三线会互相阻塞。
2. **宽容读、严格写**：未知字段忽略；未知协议、未知错误码显式失败，不静默降级。
3. **契约先行 + mock 先行**：三线各自对契约写测试，不依赖真实厂商联调。

### 5. 端口、speaker 与策略

三个层次分开，宿主只接触 `speaker`：

```ts
// 单请求适配器：一个协议一份，测试直接打它
export interface TtsProviderPort {
  readonly capabilities: TtsProviderCapabilities;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

export type TtsProviderFactory = (options: TtsProviderOptions) => TtsProviderPort;

// 文本流与段音频（与协议无关）
export interface TtsUtterance {
  readonly messageId: string;
  readonly text: AsyncIterable<string>;
}

export interface TtsSegmentAudio {
  readonly messageId: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

// 宿主唯一入口
export interface TtsSpeaker {
  readonly capabilities: TtsProviderCapabilities;
  speak(
    utterance: TtsUtterance,
    options?: { readonly signal?: AbortSignal; readonly strategy?: TtsStrategyId },
  ): AsyncIterable<TtsSegmentAudio>;
}

export function createTtsSpeaker(
  protocol: TtsProtocol,
  provider: TtsProviderOptions,
  options?: { readonly strategy?: TtsStrategyId; readonly concurrency?: number },
): TtsSpeaker;

export function createTtsProviderPort(
  protocol: TtsProtocol,
  options: TtsProviderOptions,
): TtsProviderPort;
```

- 注册表是唯一的协议到 adapter 映射点；未知协议抛 `unsupported-protocol`，不做静默降级。
- adapter 失败时抛 `TtsProviderError`，`code` 直接取自 shared 的 `TtsErrorCode`。desktop 只做一次映射，**不得二次分类**。
- `speak()` 返回 `AsyncIterable`：音频一段一段产出，宿主不必等全部完成，也不需要自己排序。
- **切句、并发、排序只在 `speaker` 内**；adapter 不认识策略，宿主不认识切句规则。

### 6. 合成策略：切句时机可替换

策略 = 「什么时候把文本切成段」+「怎么调度合成」。它住在 `packages/tts/src/strategies/`，宿主按来源固定选择：自动朗读 `sentence-pipeline`，手动朗读 `whole-text`，不暴露给用户配置。

| 策略 | 行为 | 首字延迟 | 默认用在哪 |
| --- | --- | --- | --- |
| `whole-text` | 攒完全文 → 按上限切 → 串行合成 | 全文 + 一次合成 | 手动朗读单条消息 |
| `sentence-pipeline` | 边收增量边切句 → 有界并发（默认 2）→ 按 sequence 产出 | 第一句 + 一次合成 | 演练自动朗读（默认） |

两条关键性质：

1. **退化兼容**：把单条 delta 喂给 `sentence-pipeline`，等价于「收完再切」，只是切成小段并行合成，首字仍比整段快。所以可以先按「结算发一条 delta」上线，再改逐帧，**不需要切策略、不需要改协议**。
2. **顺序由 speaker 保证**：并发完成的顺序可能乱，`speak()` 只按 `sequence` 产出；宿主与 UI 都不排序、不缓冲乱序结果。

阈值初始值参照 airi `packages/pipelines-audio/src/processors/tts-chunker.ts`：前 2 段允许在逗号处提前结束、最短 4 词、最长 12 词（中文约 8–24 字）；真实值用 Key 实测后定。

为什么策略放 `packages/tts` 而不是宿主：放 desktop/agent 会让 CLI 再实现一遍，也会把切句和协议重新缠在一起；放在库里，换策略只改库内实现。设置页不暴露策略，也没有自动朗读总开关：保存 provider 即自动朗读，未配置保持文字模式。

不做 provider 音频级流式：airi 虽然发 `stream: true`，也在适配器内把 SSE 拼成整段返回（`providers/cloud/minimax-speech/index.ts:283-321`），省时间的是早切句，不是音频流。我们同样只做文本分段。

### 7. 首版真实实现三个协议

- `minimax-native`（默认）：`POST {baseUrl}/v1/t2a_v2`，`Authorization: Bearer`，body `{ model, text, stream: false, voice_setting: { voice_id }, audio_setting: { format, sample_rate, bitrate, channel } }`，响应 `{ data: { audio: "<hex>" }, base_resp: { status_code } }`。**必须检查 `base_resp.status_code`：MiniMax 会用 HTTP 200 返回错误**（airi 实证 `packages/provider-inference/src/providers/cloud/minimax-speech/index.ts:81-95`）。
- `openai-compatible`：`POST {baseUrl}/audio/speech`，body `{ model, input, voice, response_format? }`，响应为二进制音频；覆盖 OpenAI、SiliconFlow、百炼兼容端点等。
- `chat-audio`：`POST {baseUrl}/chat/completions`，body `{ model, messages: [{ role: "assistant", content: 文本 }], audio: { format: "mp3", voice? }, stream: false }`，音频在 `choices[0].message.audio.data`（Base64）；`Authorization: Bearer` 与 `api-key` 官方都支持，adapter 统一用 Bearer。文本必须放 assistant 消息，user 消息是可选风格指令，本 adapter 不发。预设 `mimo` 指向 `https://api.xiaomimimo.com/v1` / `mimo-v2.5-tts` / `mimo_default`（小米 MiMo，当前限时免费，用作首个实机验证目标）。

`chat-audio` 与 `openai-compatible` 不能合并：前者是对话补全形状、音频在 JSON 里且待读文本放 assistant；后者是专用语音端点、音频为响应体。把两者塞进一个 adapter 只会让参数互斥表越写越长。

`dashscope` 原生（含 SSE Base64 与任务语义）不在首版：需要时按扩展规则新增，不预留半成品。

### 8. 凭证与播放是宿主职责

- `packages/tts` 只接收已解密的 `apiKey`，不读 keychain、不读 config、不写盘。
- `apps/desktop/src/main/tts/` 负责：`ClientConfig.tts` 读写、`createSystemModelCredentialStore({ account: "tts-api-key:<providerId>" })` 取 Key、按 `conversationId` 取消在途合成。
- `packages/ui/src/tts/` 负责：按 `messageId` 去重、播放队列、`stop`、Blob URL 清理。
- `apps/cli/src/speech/`（未来）负责：复用 `@answra/tts` 合成，宿主适配系统播放器；音频只在需要时进系统临时目录并在播完删除，不进业务存储。

### 9. 进程数据流

自动朗读：

```text
agent assistant 正文增量（仅 rehearsal）
  → interview-event { type: "tts-speak", conversationId, messageId, sequence, delta, final }
  → desktop ttsIntentBridge：按 messageId 攒成 AsyncIterable
  → createTtsSpeaker(protocol, provider, { strategy: settings.strategy }).speak()
  → 库内：sanitize → 切句 → 有界并发合成 → 按 sequence 产出
  → webContents.send(TtsChannels.Audio, { messageId, conversationId, source: "auto", sequence, mimeType, bytes })
  → ui TtsPlaybackProvider（按 messageId+sequence 去重）→ 顺序播放
```

手动朗读：

```text
MessageActions "朗读" → onAloud → window.answra.tts.speak({ messageId, text })
  → ttsIntentBridge 把整段文本包成单 delta（strategy: "whole-text"）
  → speaker.speak() → TtsChannels.Audio { source: "manual" }
  → ui 播放（manual 不参与自动去重）
```

取消：`ttsService.abort(conversationId)` 触发 `AbortSignal`，同时在途请求、待合成段、待播段一起停止，并广播 `TtsChannels.Stop`；renderer 停止播放并清理 Blob URL。

### 10. 明确不做

- 不新增云端 TTS 能力位（`DesktopCapability` 不加 `audio.tts`）；首版不走登录态、不做服务端转发。
- 不在 `packages/tts` 内读凭证或写文件。
- 不把合成放进 `apps/agent` 或做成 Agent 工具。
- 不做 provider 音频级流式（SSE 边合成边播）：文本分段流水线已经覆盖首字延迟；流式解码、播放缓冲与打断的复杂度高于收益。
- 不做 STT：语音输入是独立域，将来另立包（如 `@answra/stt`），不与 TTS 合并。

## 模块边界

- `packages/shared`：只放协议枚举、策略枚举、IPC DTO、厂商预设常量；不放 wire 细节、不放音频字节处理、不放 Key。
- `packages/tts`：放协议 adapter、策略层（切句/并发/排序）、Markdown 净化、注册表与错误归一；不依赖 Electron/Node 内置/Agent/config/credentials；不读环境变量。
- `packages/config`：只存非 secret 的单一 `tts.provider`；不存 Key、不存策略、不存开关。
- `packages/credentials`：只提供 `tts-api-key:` account 前缀；不感知 provider 协议。
- `apps/desktop/src/main/tts`：持有 keychain 与设置读取、把文本增量攒成交给 speaker 的流、IPC 与字节转发；不切句、不排序、不判断「该不该读」。
- `apps/agent/src/interview/tts`：只判断「仅演练、哪些正文可读」并发文本增量；不切句、不做合成、不持凭证。
- `packages/ui/src/tts`：只做播放与去重；不判断 provider、不判断策略、不解析文本、不持凭证。

## 曾考虑的替代方案

- **合成放 `apps/desktop/src/main/tts`**：舍弃。改动最小，但 `apps/cli` 将来无法复用，且 provider 逻辑会被 Electron 目录绑死；用户明确要求 CLI 以后也能支持。
- **合成放 `apps/agent/src/core/tts`**：舍弃。Agent 是平台无关运行时，塞入 HTTP provider 与音频编解码会让职责膨胀，并加大 utility process 产物；Agent 只需发朗读意图。
- **合成放 `packages/config` 或 `packages/credentials`**：舍弃。前者是配置读写、后者是 keychain 封装，都不该发起网络请求或解析音频。
- **只做一个 provider（只接 MiniMax）**：舍弃。用户明确要支持多 provider；单 provider 会让第二家变成跨层改造。
- **一个大 switch 处理所有厂商**：舍弃。协议解析、厂商默认值、鉴权会缠在一起，无法并行开发，也无法只加数据扩展厂商。
- **STT 与 TTS 合并为一个 `@answra/speech` 包**：舍弃。输入与输出生命周期、依赖（麦克风原生模块 vs HTTP）都不同，合并会让包职责过大；参考 claude-code 把采集、STT provider、命令分层。
- **首版做 DashScope 原生协议**：舍弃为后续。SSE Base64、任务语义与错误形态都更复杂；首版用 `openai-compatible` 覆盖百炼兼容端点，等真实模型需要时再按扩展规则加。
- **等全文再合成（不做分段）**：舍弃为默认。300 字点评的首字延迟约 6–8 秒，演练会像卡死；分段流水线可压到 1–2 秒，且策略化后不需要再改协议。`whole-text` 仍保留给手动朗读。
- **把策略放宿主（desktop/agent）**：舍弃。CLI 将来要重写一遍切句、并发与排序，且策略与协议会重新耦合；放 `packages/tts` 后换策略只是配置变化。
- **provider 音频级流式（SSE 边合成边播）**：舍弃为后续。airi 也把 SSE 拼成整段返回，首字收益来自早切句；流式解码、缓冲与打断的复杂度高于收益。

## 实施进度

- 已落（第 0 步）：`packages/shared/src/tts` 契约与频道、`packages/config` 的 `tts` 段、`packages/credentials` 的 `tts-api-key:` 前缀、`packages/tts` 的两个单请求 adapter，含 mock fetch 测试。
- 已落（策略化重构）：`packages/tts` 拆为 `chunk/{split,stream,sanitize}.ts`、`strategies/{wholeText,sentencePipeline}.ts`、`utterance.ts`、`speaker.ts`；`createTtsSpeaker` 返回 `AsyncIterable<TtsSegmentAudio>`；`TtsSpeakIntent` 改为 `{ conversationId, messageId, sequence, delta, final }`；shared 增加 `TtsStrategyId` 与 `unsupported-strategy`；`ClientTtsConfig` 增加 `strategy`（默认 `sentence-pipeline`，后已从配置移除，见设置简化）。`packages/tts` 53 个测试覆盖切句、流式净化、并发保序、取消与错误传播。
- 已落（A 线 desktop）：`src/main/config/clientConfigFile.ts` 提供 `config.json` 串行读改写，model 与 tts 两段互不覆盖；`src/main/tts/{ttsSettingsStore,textChannel,ttsService,ttsIpc}.ts` 接设置、keychain（`tts-api-key:<id>`）、自动/手动合成、按 `conversationId` 取消与失败归一；`window.ts` 与 preload 补齐 `sendTtsAudio/Stopped/Failed` 和 `get/save/reveal`；`agentWorkerHost`/`agentService` 订阅 `onTtsSpeak`，发送新消息前先 `stopSpeaking`。
- 已落（B 线 agent）：`src/interview/tts/rehearsalSpeech.ts` 只取演练 assistant 正文；`core/session/itemRecorder.ts` 仅在 Turn `completed` 时回调 `onAssistantMessageFinished`；`InterviewApplication.onAssistantReply` 与 `host.emitTtsSpeak` 只由演练领域接线；`worker/protocol.ts` 新增 `tts-speak` 帧。
- 已落（C 线 ui）：`packages/ui/src/tts/useTtsPlayback.ts` 串行播放、`auto` 按 `messageId+sequence` 去重、`manual` 可重播、`stop` 清队列与 Blob URL；`MessageActions → AssistantMessage → ChatPanel` 透传 `onAloud`（无 handler 不显示菜单项）；`TtsSettingsGroup` 接入 `SettingsPanel`；切换模式/取消时 `stopTts`。
- 门禁：`pnpm verify`（lint + typecheck + db:check + 全包 vitest + profiles + architecture + tokens + notes:hint）与 `pnpm notes:check` 均通过；新增 desktop 54 文件 390 测试、UI TTS 6 文件 39 测试、agent interview 91 测试。
- 已落（第三个协议）：`chat-audio` adapter 与 `mimo` 预设，覆盖 `chat/completions` 形状（assistant 文本、Base64 音频、`mp3`、音色可留空）；设置页切协议时按预设回填端点/模型/音色。`packages/tts` 60 个测试通过。
- 已落（厂商目录与设置简化）：`packages/shared/src/tts/catalog.ts` 提供 `TTS_PROVIDER_CATALOG`（MiniMax / MiMo / OpenAI），`TTS_PROTOCOL_PRESETS` 由目录派生；设置页用带品牌图标的供应商下拉，直接展示单一 provider 表单，与「模型」分组一致。预设厂商的端点锁定为目录值（只读），协议与端点只在「自定义」里可改；模型、音色与 Key 可填。`ClientTtsConfig` 从 `providers[] + activeProviderId` 收敛为 `provider`，旧配置读取时迁移；`strategy` 不再写盘，自动朗读固定 `sentence-pipeline`、手动朗读固定 `whole-text`，设置页不再暴露策略。配置仍不存 `presetId`。详见 `docs/notes/implemented/feature/2026-11-28-tts-provider-settings.md`。
- 待办：Windows 实机用真实 Key 验证音色、首字延迟、`base_resp.status_code` 非 0（MiniMax）或音频缺失（MiMo）的提示与切换模式打断；实机通过后本 Note 与功能 Note 一并迁 `implemented/`。

## 验收标准

- 可观察结果：设置里选择供应商并保存一个 TTS provider；MiniMax、任一 OpenAI 兼容端点与 MiMo 对话式音频端点都能合成；演练模式自动朗读一次且仅一次；辅助模式不发声；切换 provider 后下一次朗读使用新配置；切换模式/停止时播放立即中止且不残留队列。
- 策略：自动朗读固定 `sentence-pipeline`、手动朗读固定 `whole-text`，用户不可配置；`whole-text` 与 `sentence-pipeline` 对单 delta 输入产出相同文本内容；多 delta 输入按 `sequence` 递增产出、不丢段、不重排。切换策略只改库内实现，不改协议与三端代码。
- 自动化验证：
  - `packages/tts` 两个 adapter 用 mock fetch 覆盖请求 URL/headers/body、hex 与二进制响应、`base_resp.status_code` 非 0、非音频响应、空音频。
  - 错误归一：业务码非 0 → `provider-rejected`，401/403 → `unauthorized`，超时 → `timeout`，取消 → `aborted` 且不产生用户可见错误，空音频 → `empty-audio`。
  - 切句：增量输入与整段输入切出的段一致；跨 delta 的 `**加粗**` 与代码块不读出符号；超长单句硬切不劈代理对。
  - `createTtsSpeaker` 未知协议抛 `unsupported-protocol`、未知策略抛 `unsupported-strategy`；非法 `providerId` 在保存时被拒绝。
  - 预设 `capabilities` 与 adapter 自身常量逐项一致；UI 只按声明渲染参数控件。
  - `apps/desktop` 覆盖 settings 读写、keychain 隔离（`tts-api-key:<id>` 与 `local-model-api-key` 不互通）、取消在途合成。
  - `packages/ui` 覆盖按 `messageId+sequence` 去重、manual 可重播、stop 清理 Blob URL。
- 需要的实机验证：Windows 桌面端用真实 MiniMax / MiMo Key 验证音色、首字延迟（300 字回复目标 < 2s）、错误提示（HTTP 200 但 `status_code` 非 0）、切换模式打断；未完成前本 Note 保持 `proposed`。

## 风险

- **协议假设风险**：OpenAI 兼容端点的行为因厂商而异（是否支持 `response_format`、返回 MIME 是否准确）；adapter 必须按真实响应校验，不能只看 HTTP 200。
- **MiniMax 错误语义**：HTTP 200 + `base_resp.status_code` 非 0 是拒绝；漏检会把错误当成功并播放空音频。
- **段间间隙**：分段播放靠 `ended` 接力，可能有几十毫秒静音；手动朗读用 `whole-text` 规避，自动朗读需实机确认可接受。
- **流式净化**：未闭合的 Markdown/代码块必须有缓冲与超长兜底，否则会把 `**`、```` ``` ```` 读出来。
- **增量帧量**：逐帧 delta 会增加 worker → main 的消息量，需确认不重复发送正文（与 live frame 同量级即可）。
- **IPC 体积**：音频字节经 `webContents.send` 传递需有界；单帧设上限，超限由策略切段，不允许一帧塞整段长回复。
- **凭证泄漏面**：Key 只在 main 解密并传给 `packages/tts`；禁止进日志、禁止进 renderer、禁止进 config。keychain 不可用时 fail-closed。
- **契约漂移**：adapter 与 desktop 各写一套错误分类、预设 `capabilities` 与 adapter 常量不同步，会让「UI 说支持、实际不支持」这类问题无法定位。约束：`TtsErrorCode` 只在 `packages/shared` 定义一次，adapter 直接复用；desktop 只做一层映射；预设与 adapter 常量用测试锁住。
- **新增包的门禁**：`packages/tts` 若引入 `node:` 内置，需要同步 `scripts/architecture/architecture-check.mjs` 白名单；实施时同时更新 `AGENTS.md` 与 `README.md` 仓库结构表。
- **CLI 播放差异**：CLI 无 Web Audio，系统播放器行为与临时文件生命周期不同；本提案只保证合成层可复用，CLI 播放适配另立 Note。
