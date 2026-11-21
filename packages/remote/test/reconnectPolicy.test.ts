import { describe, expect, it } from "vitest";
import {
  REMOTE_RECONNECT_MAX_ATTEMPTS,
  REMOTE_RECONNECT_MAX_ELAPSED_MS,
  RemoteReconnectPolicy,
} from "../src";

function createPolicy(
  options: {
    now?: () => number;
    random?: () => number;
    maxAttempts?: number;
    maxElapsedMs?: number;
  } = {},
) {
  return new RemoteReconnectPolicy({
    now: options.now ?? (() => 0),
    random: options.random ?? (() => 0.5),
    baseDelaysMs: [1_000, 2_000, 4_000],
    maxAttempts: options.maxAttempts ?? REMOTE_RECONNECT_MAX_ATTEMPTS,
    maxElapsedMs: options.maxElapsedMs ?? REMOTE_RECONNECT_MAX_ELAPSED_MS,
  });
}

describe("remote reconnect policy", () => {
  it("uses exponential delays with deterministic jitter", () => {
    const policy = createPolicy();

    expect(policy.next()).toEqual({ kind: "retry", attempt: 1, delayMs: 1_000 });
    expect(policy.next()).toEqual({ kind: "retry", attempt: 2, delayMs: 2_000 });
    expect(policy.next()).toEqual({ kind: "retry", attempt: 3, delayMs: 4_000 });
    expect(policy.next()).toEqual({ kind: "exhausted", attempts: 3, elapsedMs: 0 });
  });

  it("applies jitter in both directions", () => {
    const low = createPolicy({ random: () => 0 });
    const high = createPolicy({ random: () => 1 });

    expect(low.next()).toMatchObject({ kind: "retry", delayMs: 800 });
    expect(high.next()).toMatchObject({ kind: "retry", delayMs: 1_200 });
  });

  it("exhausts after the elapsed budget even with attempts remaining", () => {
    let now = 0;
    const policy = createPolicy({ now: () => now, maxElapsedMs: 5_000, maxAttempts: 10 });

    expect(policy.next()).toMatchObject({ kind: "retry", attempt: 1 });
    now = 5_000;
    expect(policy.next()).toEqual({ kind: "exhausted", attempts: 1, elapsedMs: 5_000 });
  });

  it("resets attempts and elapsed time after a successful connection", () => {
    let now = 0;
    const policy = createPolicy({ now: () => now });

    expect(policy.next()).toMatchObject({ kind: "retry", attempt: 1 });
    now = 1_000;
    policy.reset();
    expect(policy.attemptsMade()).toBe(0);
    expect(policy.elapsedMs()).toBe(0);
    expect(policy.next()).toMatchObject({ kind: "retry", attempt: 1, delayMs: 1_000 });
  });
});
