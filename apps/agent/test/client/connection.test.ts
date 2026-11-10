import type { AgentWorkerExit } from "@answra/agent";
import {
  AgentConnectionSupervisor,
  type AgentWorkerHost,
  AgentWorkerStartError,
} from "@answra/agent";
import type { AgentConnectionState } from "@answra/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createHarness(failures = 0) {
  let remainingFailures = failures;
  let startCalls = 0;
  const exitListeners = new Set<(exit: AgentWorkerExit) => void>();
  const host: AgentWorkerHost = {
    start: vi.fn(async () => {
      startCalls += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new AgentWorkerStartError("readiness-timeout", "worker readiness timed out");
      }
    }),
    stop: vi.fn(async () => undefined),
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };
  return {
    host,
    get startCalls() {
      return startCalls;
    },
    setFailures(value: number) {
      remainingFailures = value;
    },
    exit(code = 1) {
      for (const listener of [...exitListeners]) listener({ code });
    },
  };
}

function createSupervisor(harness: ReturnType<typeof createHarness>) {
  return new AgentConnectionSupervisor(harness.host, {
    policy: { maxAttempts: 3, retryDelaysMs: [10, 20] },
  });
}

describe("AgentConnectionSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes a monotonic connecting -> connected sequence", async () => {
    const harness = createHarness();
    const supervisor = createSupervisor(harness);
    const revisions: number[] = [];
    const unsubscribe = supervisor.subscribe((state) => revisions.push(state.revision));

    await supervisor.ensureStarted();

    expect(supervisor.getState()).toMatchObject({
      target: "agent-service",
      status: "connected",
      attempt: 1,
      maxAttempts: 3,
    });
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
    unsubscribe();
  });

  it("backs off after readiness failures and reconnects on a later attempt", async () => {
    const harness = createHarness(2);
    const supervisor = createSupervisor(harness);
    const states: AgentConnectionState[] = [];
    supervisor.subscribe((state) => states.push(state));

    const started = supervisor.ensureStarted();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await started;

    expect(harness.startCalls).toBe(3);
    expect(states).toContainEqual(
      expect.objectContaining({
        status: "reconnecting",
        attempt: 2,
        nextRetryAt: 1_010,
        reason: "readiness-timeout",
      }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({ status: "reconnecting", attempt: 3, nextRetryAt: 1_030 }),
    );
    expect(supervisor.getState()).toMatchObject({ status: "connected", attempt: 3 });
  });

  it("reports unavailable after max attempts and starts a new episode on the next request", async () => {
    const harness = createHarness(3);
    const supervisor = createSupervisor(harness);

    const started = supervisor.ensureStarted();
    const rejection = started.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(String(await rejection)).toContain("agent-service-disconnected");

    expect(supervisor.getState()).toMatchObject({
      status: "unavailable",
      attempt: 3,
      reason: "readiness-timeout",
    });

    harness.setFailures(0);
    await supervisor.ensureStarted();

    expect(supervisor.getState()).toMatchObject({ status: "connected", attempt: 1 });
    expect(harness.startCalls).toBe(4);
  });

  it("auto reconnects when a connected worker exits", async () => {
    const harness = createHarness();
    const supervisor = createSupervisor(harness);
    await supervisor.ensureStarted();

    harness.exit(7);
    expect(supervisor.getState()).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      reason: "worker-exit",
      detail: "worker exited (7)",
    });

    await vi.runAllTimersAsync();
    expect(supervisor.getState()).toMatchObject({ status: "connected", attempt: 1 });
    expect(harness.startCalls).toBe(2);
  });

  it("does not reconnect after dispose", async () => {
    const harness = createHarness();
    const supervisor = createSupervisor(harness);
    await supervisor.ensureStarted();

    await supervisor.dispose();
    harness.exit(1);
    await vi.runAllTimersAsync();

    expect(harness.startCalls).toBe(1);
  });

  it("stops retrying when disposed during backoff", async () => {
    const harness = createHarness(3);
    const supervisor = createSupervisor(harness);
    supervisor.subscribe(() => undefined);

    const started = supervisor.ensureStarted();
    const rejection = started.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await supervisor.dispose();
    expect(String(await rejection)).toContain("agent-service-disconnected");
    await vi.runAllTimersAsync();

    expect(harness.startCalls).toBe(1);
  });
});
