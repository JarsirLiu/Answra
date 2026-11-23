/** 恢复顺序与幂等性的端口级测试：不依赖真实条目存储或 transcript。 */
import { describe, expect, it, vi } from "vitest";
import {
  type SessionId,
  type SessionRecoveryPlan,
  sessionId,
  type TurnRunContext,
  turnId,
} from "../../../src/core/session/contracts";
import { SessionRecoveryCoordinator } from "../../../src/core/session/recoveryCoordinator";

const SESSION = sessionId("recovery-session");
const RUNTIME: TurnRunContext = { getAccessToken: async () => "token" };

function plan(closed: boolean): SessionRecoveryPlan {
  return {
    closedTurnIds: closed ? [turnId("turn-1")] : [],
    pendingTurnIds: [],
  };
}

function createCoordinator({
  closed = true,
  failRecovery = false,
}: {
  closed?: boolean;
  failRecovery?: boolean;
} = {}) {
  const calls: string[] = [];
  const ports = {
    recoverFacts: vi.fn(async (_id: SessionId) => {
      calls.push("recoverFacts");
      if (failRecovery) throw new Error("recover failed");
      return plan(closed);
    }),
    refreshTranscript: vi.fn(async (_id: SessionId) => {
      calls.push("refreshTranscript");
    }),
    resumeQueued: vi.fn(async (_id: SessionId, _runtime: TurnRunContext) => {
      calls.push("resumeQueued");
    }),
    onRecovered: vi.fn(async () => {
      calls.push("onRecovered");
    }),
  };
  return { coordinator: new SessionRecoveryCoordinator(ports), ports, calls };
}

describe("SessionRecoveryCoordinator", () => {
  it("closes facts, rebuilds the message view, then resumes queued turns in one fixed order", async () => {
    const { coordinator, ports, calls } = createCoordinator();

    await coordinator.ensure(SESSION, RUNTIME);

    expect(calls).toEqual(["recoverFacts", "refreshTranscript", "resumeQueued", "onRecovered"]);
    expect(ports.resumeQueued).toHaveBeenCalledWith(SESSION, RUNTIME);
    expect(ports.onRecovered).toHaveBeenCalledWith(SESSION, plan(true));
  });

  it("keeps recovery idempotent per session", async () => {
    const { coordinator, ports } = createCoordinator();

    await coordinator.ensure(SESSION, RUNTIME);
    await coordinator.ensure(SESSION, RUNTIME);

    expect(coordinator.isRecovered(SESSION)).toBe(true);
    expect(ports.recoverFacts).toHaveBeenCalledTimes(1);
    expect(ports.refreshTranscript).toHaveBeenCalledTimes(1);
    expect(ports.resumeQueued).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent ensure calls instead of recovering twice", async () => {
    const { coordinator, ports } = createCoordinator();

    await Promise.all([coordinator.ensure(SESSION, RUNTIME), coordinator.ensure(SESSION, RUNTIME)]);

    expect(ports.recoverFacts).toHaveBeenCalledTimes(1);
    expect(ports.refreshTranscript).toHaveBeenCalledTimes(1);
  });

  it("retries next time when recovery fails", async () => {
    const { coordinator, ports } = createCoordinator({ failRecovery: true });

    await expect(coordinator.ensure(SESSION, RUNTIME)).rejects.toThrow("recover failed");
    expect(coordinator.isRecovered(SESSION)).toBe(false);

    ports.recoverFacts.mockImplementation(async () => plan(false));
    await coordinator.ensure(SESSION, RUNTIME);
    expect(coordinator.isRecovered(SESSION)).toBe(true);
  });

  it("re-recovers after forget", async () => {
    const { coordinator, ports } = createCoordinator();

    await coordinator.ensure(SESSION, RUNTIME);
    coordinator.forget(SESSION);
    await coordinator.ensure(SESSION, RUNTIME);

    expect(ports.recoverFacts).toHaveBeenCalledTimes(2);
  });
});
