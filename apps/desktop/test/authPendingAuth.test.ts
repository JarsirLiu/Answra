import { describe, expect, it } from "vitest";
import { PENDING_AUTH_TTL_MS, PendingAuthRegistry } from "../src/main/auth/pendingAuth";

/**
 * 待处理登录：一次性 state + TTL + redirect_uri 绑定。
 * 这里覆盖并发/冷启动最容易踩的几条路径（重放、过期、串回调）。
 */
const INPUT = {
  state: "state-1",
  verifier: "verifier-1",
  redirectUri: "answra://auth/callback",
};

describe("PendingAuthRegistry", () => {
  it("consumes a matching callback exactly once", () => {
    const registry = new PendingAuthRegistry();
    registry.create(INPUT, 1_000);
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 1_500)).toEqual(
      {
        ok: true,
        pending: { ...INPUT, createdAt: 1_000 },
      },
    );
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 1_600)).toEqual(
      {
        ok: false,
        reason: "no-pending",
      },
    );
    expect(registry.hasPending()).toBe(false);
  });

  it("rejects an unknown state but still drops the pending login", () => {
    const registry = new PendingAuthRegistry();
    registry.create(INPUT, 1_000);
    expect(
      registry.consume({ state: "replayed", target: "answra://auth/callback" }, 1_100),
    ).toEqual({
      ok: false,
      reason: "unknown-state",
    });
    // 攻击者用旧 state 探测过一次后，真正的回调也不能再被接受。
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 1_200)).toEqual(
      { ok: false, reason: "no-pending" },
    );
  });

  it("rejects a callback past the 2 minute TTL", () => {
    const registry = new PendingAuthRegistry();
    registry.create(INPUT, 0);
    expect(
      registry.consume({ state: "state-1", target: "answra://auth/callback" }, PENDING_AUTH_TTL_MS),
    ).toEqual({ ok: true, pending: { ...INPUT, createdAt: 0 } });
    registry.create(INPUT, 0);
    expect(
      registry.consume(
        { state: "state-1", target: "answra://auth/callback" },
        PENDING_AUTH_TTL_MS + 1,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a callback whose target differs from the requested redirect_uri", () => {
    const registry = new PendingAuthRegistry();
    registry.create(INPUT, 0);
    expect(
      registry.consume({ state: "state-1", target: "http://127.0.0.1:5000/auth/callback" }, 1),
    ).toEqual({ ok: false, reason: "redirect-mismatch" });
  });

  it("replaces the previous pending login on a new attempt", () => {
    const registry = new PendingAuthRegistry();
    const first = registry.create(INPUT, 0);
    const second = registry.create({ ...INPUT, state: "state-2" }, 10);
    expect(first.replaced).toBeNull();
    expect(second.replaced?.state).toBe("state-1");
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 20)).toEqual({
      ok: false,
      reason: "unknown-state",
    });
  });

  it("restores a persisted pending login for cold-start deep links", () => {
    const registry = new PendingAuthRegistry();
    registry.restore({ ...INPUT, createdAt: 5_000 });
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 5_100)).toEqual(
      {
        ok: true,
        pending: { ...INPUT, createdAt: 5_000 },
      },
    );
  });

  it("clears on logout", () => {
    const registry = new PendingAuthRegistry();
    registry.create(INPUT, 0);
    registry.clear();
    expect(registry.consume({ state: "state-1", target: "answra://auth/callback" }, 1)).toEqual({
      ok: false,
      reason: "no-pending",
    });
  });
});
