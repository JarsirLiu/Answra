# @answra/tts

宿主无关的语音合成核心：协议适配器、Markdown 净化、切句策略与错误归一。

## 边界

- 只依赖 `@answra/shared`；不 import `electron`、`node:` 内置、Agent、config、credentials。
- 只接收已解密的 `apiKey`；不读 keychain、不读配置文件、不写盘。
- 不播放：桌面用渲染进程的 `HTMLAudioElement`，未来 CLI 用系统播放器。
- 不决定「哪些文本该读」：agent 只发可朗读正文增量，合成库只决定「怎么切、怎么合成」。

## 用法

```ts
import { createTtsSpeaker } from "@answra/tts";

const speaker = createTtsSpeaker("minimax-native", {
  baseUrl: "https://api.minimax.io",
  model: "speech-2.8-turbo",
  apiKey,
  voice,
});

const segments = speaker.speak(
  { messageId, text: deltas },
  { signal, strategy: "sentence-pipeline" },
);

for await (const { sequence, bytes, mimeType } of segments) {
  // 宿主按 messageId + sequence 逐帧下发；顺序已由 speaker 保证。
}
```

- `text` 是 `AsyncIterable<string>`：整段模式传一条，逐帧模式传多条。
- `strategy` 默认取 speaker 构造参数，再回退 `sentence-pipeline`。
- 手动朗读单条消息传 `whole-text`，避免段间间隙。

## 策略

| id | 行为 | 用在哪 |
| --- | --- | --- |
| `whole-text` | 攒完全文 → 按 provider 上限切 → 串行合成 | 手动朗读、短回复 |
| `sentence-pipeline` | 边收边切 → 有界并发 → 按 `sequence` 产出 | 自动朗读（默认） |

切句阈值参照 airi `tts-chunker`：开头 2 段允许在逗号处提前结束、最少 4 词、最长 12 词；真实值待实测。

## 扩展

- 新增一家 OpenAI 兼容厂商：只加预设数据，不写代码。
- 新增一种 wire 格式：加一个 `src/protocols/*.ts`，在 `src/registry.ts` 登记一行，
  并在 `@answra/shared/tts` 的 `TTS_PROTOCOLS` 加一个值。
- 新增一种切句/调度方式：加一个 `src/strategies/*.ts`，在 `src/strategies/index.ts` 登记，
  并在 `@answra/shared/tts` 的 `TTS_STRATEGIES` 加一个值；宿主不改。
