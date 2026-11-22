/** 恢复顺序与幂等性的端口级测试：不依赖真实 journal 或 transcript。 */
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

function plan(interrupted: boolean): SessionRecoveryPlan {
  return {
    projection: {
      sessionId: SESSION,
      sequence: 0,
      turns: [],
      queue: [],
      steps: [],
      compactions: [],
    },
    interruptedTurnIds: interrupted ? [turnId("turn-1")] : [],
    interruptedStepIds: [],
    interruptedCompactionIds: [],
  };
}

function createCoordinator({
  revision = 7,
  interrupted = true,
  failRecovery = false,
}: {
  revision?: number;
  interrupted?: boolean;
  failRecovery?: boolean;
} = {}) {
  const calls: string[] = [];
  const ports = {
    recoverFacts: vi.fn(async (_id: SessionId) => {
      calls.push("recoverFacts");
      if (failRecovery) throw new Error("recover failed");
      return plan(interrupted);
    }),
    resumeQueued: vi.fn(async (_id: SessionId, _runtime: TurnRunContext) => {
      calls.push("resumeQueued");
    }),
    eventRevision: vi.fn(async () => {
      calls.push("eventRevision");
      return revision;
    }),
    seedRevision: vi.fn(async () => {
      calls.push("seedRevision");
    }),
    revision: vi.fn(async () => {
      calls.push("revision");
      return revision;
    }),
    suspendUi: vi.fn((_id: SessionId, suspended: boolean) => {
      calls.push(suspended ? "suspend" : "resume");
    }),
    restoreTranscript: vi.fn(async () => {
      calls.push("restoreTranscript");
    }),
    onRecovered: vi.fn(async () => {
      calls.push("onRecovered");
    }),
  };
  return { coordinator: new SessionRecoveryCoordinator(ports), ports, calls };
}

describe("SessionRecoveryCoordinator", () => {
  it("runs seed, recover, transcript restore, then queued resume in one fixed order", async () => {
    const { coordinator, ports, calls } = createCoordinator();

    await coordinator.ensure(SESSION, RUNTIME);

    expect(calls).toEqual([
      "eventRevision",
      "seedRevision",
      "suspend",
      "recoverFacts",
      "resume",
      "revision",
      "restoreTranscript",
      "resumeQueued",
      "onRecovered",
    ]);
    expect(ports.seedRevision).toHaveBeenCalledWith(SESSION, 7);
    expect(ports.restoreTranscript).toHaveBeenCalledWith(SESSION, plan(true), 7);
    expect(ports.resumeQueued).toHaveBeenCalledWith(SESSION, RUNTIME);
  });

  it("keeps recovery idempotent per session", async () => {
    const { coordinator, ports } = createCoordinator();

    await coordinator.ensure(SESSION, RUNTIME);
    await coordinator.ensure(SESSION, RUNTIME);

    expect(coordinator.isRecovered(SESSION)).toBe(true);
    expect(ports.recoverFacts).toHaveBeenCalledTimes(1);
    expect(ports.restoreTranscript).toHaveBeenCalledTimes(1);
    expect(ports.resumeQueued).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent ensure calls instead of recovering twice", async () => {
    const { coordinator, ports } = createCoordinator();

    await Promise.all([coordinator.ensure(SESSION, RUNTIME), coordinator.ensure(SESSION, RUNTIME)]);

    expect(ports.recoverFacts).toHaveBeenCalledTimes(1);
    expect(ports.suspendUi).toHaveBeenCalledTimes(2);
  });

  it("resumes UI projection even when recovery fails, and retries next time", async () => {
    const { coordinator, ports } = createCoordinator({ failRecovery: true });

    await expect(coordinator.ensure(SESSION, RUNTIME)).rejects.toThrow("recover failed");
    expect(ports.suspendUi).toHaveBeenCalledWith(SESSION, false);
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

  it("does not push a snapshot when nothing was interrupted", async () => {
    const { coordinator, ports } = createCoordinator({ interrupted: false });

    await coordinator.ensure(SESSION, RUNTIME);

    expect(ports.onRecovered).toHaveBeenCalledWith(SESSION, plan(false));
  });
});
