// eot-bench 的纯 turn-end 评分逻辑；不包含 ASR 或模型准确率口径。

export interface TurnEndObservation {
  endSample: number;
  observedSample: number;
}

export interface SilenceSpan {
  start: number;
}

export interface TurnEndScore {
  eotDetected: boolean;
  eotDetectionLatencyMs: number | undefined;
  holdFalseCutoffs: number;
  falseTurnEnds: number;
}

export function scoreTurnEnds(
  observations: readonly TurnEndObservation[],
  silenceSpans: readonly SilenceSpan[],
  sampleRate: number,
  toleranceMs: number,
): TurnEndScore {
  const eotIndex = silenceSpans.length - 1;
  const eotSpan = silenceSpans[eotIndex];
  let eotDetectionLatencyMs: number | undefined;
  let holdFalseCutoffs = 0;
  let falseTurnEnds = 0;
  let eotDetectionCount = 0;

  for (const observation of observations) {
    if (!eotSpan) {
      falseTurnEnds += 1;
      continue;
    }
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, span] of silenceSpans.entries()) {
      const distance = Math.abs(observation.endSample / sampleRate - span.start);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestDistance > toleranceMs / 1_000) {
      falseTurnEnds += 1;
      continue;
    }

    if (bestIndex === eotIndex) {
      eotDetectionCount += 1;
      if (eotDetectionCount === 1)
        eotDetectionLatencyMs = Math.round(
          (observation.observedSample / sampleRate - eotSpan.start) * 1_000,
        );
      else falseTurnEnds += 1;
    } else {
      falseTurnEnds += 1;
      if (bestIndex >= 0) holdFalseCutoffs += 1;
    }
  }

  return {
    eotDetected: eotDetectionLatencyMs !== undefined,
    eotDetectionLatencyMs,
    holdFalseCutoffs,
    falseTurnEnds,
  };
}
