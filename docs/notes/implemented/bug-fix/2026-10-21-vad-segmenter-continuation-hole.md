# Note：VAD 强切 chunk 在采样坐标上挖洞丢音频

状态：已实施

## 问题

为 `apps/agent/src/interview/vad/segmenter.ts` 补专属单测（[面试语音 VAD 选型](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md) 阶段 3 收口遗留项）时发现：强切（4.5s 上限、最低 RMS 选点）只把切点前 `VAD_CHUNK_OVERLAP_SAMPLES` 的窗口带进后继 chunk，切点后到 chunk 已积累头部之间的音频 `[cutSample, chunkTail)` 既不在闭合的旧段里、也不在新头里，且后继 chunk 开头会把未来帧的字节接到中段旧音频之后——采样范围声称连续，字节实际跳变。生产 100ms 帧下洞最大接近 4.5s（4.5s 上限内切点任意处），翻译侧按范围去重、衔接都会错位。

旁证：`D:\codespace\natively-cluely-ai-assistant\electron\audio\whisper\vadProcessor.ts` 的 `softCommit` 注释明示"切段后不保留尾部连续性时，Whisper 在后继段的首词经常漏听"——不同实现、同一类失败模式，佐证切段必须保留切点与边界之间的内容。该参照没有采样范围去重契约，本仓库语义更强（10-16 Note：continuation + 稳定范围去重），故不做双段式硬截断。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/segmenter.ts`（`splitLongChunk` + `lowestRmsSampleOffset`）、`apps/agent/test/interview/vad/segmenter.test.ts`（两条强切行为测试）。
- UI/进程/协议/持久化表面：`AudioSegment` 契约不变；分段的去重衔接语义从"只看重叠窗"升级为"重叠窗 + 切后连续"，是 10-16 Note 既定语义的正确实现，不属于契约扩面。

## 根因

`splitLongChunk` 原实现取 `open.pcm.subarray((cutOffset - VAD_CHUNK_OVERLAP_SAMPLES) * 2, cutOffset * 2)` 作为新 chunk 头——只带重叠窗；后续 `appendChunk` 按字节接力把新帧接在尾部，但新帧的流位置（stream end）远大于新 chunk 声称的 `[chunkStartSample + 1_600)`,坐标与连续语义脱节。

## 决定

- 后继 chunk 头部 = 重叠窗 `[cut-1_600, cut)` **加**切点后全部已积累音频 `[cut, chunkTail)`，即 `open.pcm.subarray((cutOffset - VAD_CHUNK_OVERLAP_SAMPLES) * 2)`（到尾部）。采样范围在 chunk 间连续、去重窗口不变；上游 natively-cluely 的"无尾部连续性导致丢首词"教训对应同一取舍，舍弃硬截断方案。
- 新增防环下限：`OpenChunk.rmsScanStart`（相对 chunk 的最低 RMS 窗口**起点**下限），切过一刀的 chunk 置为 `VAD_CHUNK_OVERLAP_SAMPLES`。上一刀中心相对新 chunk 恰在 1_600（1_600 ≡ 0 mod 160，含该中心的窗口起点是 1_520 < 1_600 被排除），故下一刀必然晚于上一刀所在窗口。没有它，若最低 RMS 低谷一直留在重叠区附近，每一刀会重复选中同一窗口：chunk 永不推进且无限重复转写同一音频，即使在"保留切后尾巴"方案下依然存在。
- `lowestRmsSampleOffset` 更名 `lowestRmsCenterOffset` 并接受 `scanStart`：从 ≥ scanStart 的第一个 160 对齐窗口开始扫描；fresh chunk 传 0，保持原行为（含 `max(VAD_CHUNK_OVERLAP_SAMPLES, …)` 下限）。

## 修复

- `apps/agent/src/interview/vad/segmenter.ts`：`OpenChunk` 增加 `rmsScanStart`；`openChunk` 初始化 0；`splitLongChunk` 保留切后尾巴、新 chunk `rmsScanStart = VAD_CHUNK_OVERLAP_SAMPLES`；扫描函数按窗口起点下限扫描。
- `apps/agent/test/interview/vad/segmenter.test.ts`：
  - `force-splits at the lowest-RMS window with a one-frame continuation overlap`——多窗低谷 [40_000, 41_600) 场景：切点 40_080、seg1 `[0..40_080)` continuation、seg2 起点回退 1_600 且 pcm 逐字节连续（含切后内容），重叠窗重放相等。修复前本条为红（新 chunk 字节流跳变、`[40_080..73_728)` 内容丢失）。
  - `carries the post-cut tail forward and only cuts after the previous cut window`——单窗低谷 [40_000, 40_160) 场景：第一刀 40_080，第二刀必须在 40_160（低谷后的第一个允许窗口）而非重复切 40_080；两刀重叠区一致重放、低谷完整保留在第二段内。

## 影响表面

- chunk 的 pcm 内存形态变化：强切后新 chunk 可能携带最多 ~4.5s 的既有音频（切点偏早时），上限约 72_000+1_600 样本，不会无界增长——每次切点严格前进。阶段 4 的 ASR 请求队列按 chunk 上限计费/分批时需注意单 chunk 上限仍以 `VAD_MAX_CHUNK_MS + VAD_CHUNK_OVERLAP_SAMPLES` 为参照。
- close-then-replay 模式的重复转写由"范围去重"契约吸收，与 10-16 Note 一致。

## 曾考虑的替代方案

- **硬截断（闭合 `[0..cut)`,丢弃 `[cut..tail)`，参照 natively-cluely force-flush）：** 生产参数下最多丢 4.5s 真实语音硬边界，且接缝两侧坐标对不齐，与去重衔接契约矛盾。舍弃。
- **只调 Notes/测试去匹配丢失行为：** 把契约缺陷合理化，转录质量直接受损。舍弃。
- **不加防环下限，只修尾巴保留：** 低谷长驻重叠区时每刀重复切同一窗口，chunk 永不推进、无界重复转写。舍弃。

## 后果与防回退

- 两条强切行为测试成为去重衔接语义的防回退锚点：任何"又丢尾巴"或"重切同点"的实现都会红。
- 后续若把 `VAD_CHUNK_OVERLAP_SAMPLES`/`RMS_WINDOW_SAMPLES` 换值，两测试的数值是联动的（测试显式引用常量计算期望值）。

## 验证

- 修复前：`force-splits…` 红——Receipted 新 chunk 字节流 `…中段旧音频 + 直接跳到流尾样本…`；修复后 `pnpm --filter @answra/agent test -- segmenter` 10/10 通过。
- 参考：natively-cluely `vadProcessor.ts` softCommit 注释（external，只作佐证不参与断言）。
