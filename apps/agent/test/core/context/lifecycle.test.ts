import { describe, expect, it } from "vitest";
import {
  canTransitionContextCompaction,
  markContextCompactionAborted,
  markContextCompactionFailed,
  markContextCompactionSucceeded,
  startContextCompaction,
} from "../../../src/core/context/compaction/lifecycle";

const NOW = () => new Date("2026-11-13T10:00:00.000Z");

describe("context compaction lifecycle", () => {
  it("moves auto compaction from start to success", () => {
    const started = startContextCompaction({ previous: undefined, trigger: "auto", now: NOW });
    const succeeded = markContextCompactionSucceeded(started, 12, NOW);

    expect(started.state).toBe("started");
    expect(succeeded).toMatchObject({
      state: "succeeded",
      trigger: "auto",
      summarizedMessages: 12,
      finishedAt: "2026-11-13T10:00:00.000Z",
    });
  });

  it("records a failure with the model error", () => {
    const started = startContextCompaction({ previous: undefined, trigger: "auto", now: NOW });
    const failed = markContextCompactionFailed(started, "摘要模型不可用", NOW);

    expect(failed).toMatchObject({
      state: "failed",
      errorText: "摘要模型不可用",
      finishedAt: "2026-11-13T10:00:00.000Z",
    });
  });

  it("records cancellation without turning it into a failure", () => {
    const started = startContextCompaction({ previous: undefined, trigger: "manual", now: NOW });
    const aborted = markContextCompactionAborted(started, NOW);

    expect(aborted).toMatchObject({
      state: "aborted",
      trigger: "manual",
      finishedAt: "2026-11-13T10:00:00.000Z",
    });
    expect(aborted.errorText).toBeUndefined();
  });

  it("allows a new attempt after success or failure", () => {
    const previous = {
      state: "succeeded" as const,
      trigger: "auto" as const,
      startedAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:01.000Z",
      finishedAt: "2026-11-12T00:00:01.000Z",
    };

    expect(startContextCompaction({ previous, trigger: "auto", now: NOW }).state).toBe("started");
  });

  it("allows started to finish once and rejects overlapping or terminal-to-terminal transitions", () => {
    expect(canTransitionContextCompaction("started", "succeeded")).toBe(true);
    expect(canTransitionContextCompaction("started", "failed")).toBe(true);
    expect(canTransitionContextCompaction("started", "aborted")).toBe(true);
    expect(canTransitionContextCompaction("started", "started")).toBe(false);
    expect(canTransitionContextCompaction("failed", "succeeded")).toBe(false);
    expect(() =>
      startContextCompaction({
        previous: {
          state: "started",
          trigger: "auto",
          startedAt: "2026-11-12T00:00:00.000Z",
          updatedAt: "2026-11-12T00:00:00.000Z",
        },
        trigger: "auto",
        now: NOW,
      }),
    ).toThrow("非法上下文压缩状态迁移");
  });
});
