import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateImeInputTarget,
  disposeImeInputCoordinator,
  enqueueImeInput,
  getImeInputCoordinatorState,
  releaseImeInputTarget,
  resetImeInputTargetCoordinatorForTests,
} from "../src/ime/imeInputTargetCoordinator";

describe("renderer IME input coordinator", () => {
  beforeEach(() => resetImeInputTargetCoordinatorForTests());

  it("assigns increasing event ids to serialized input", async () => {
    activateImeInputTarget("composer", vi.fn());
    const events: number[] = [];

    await enqueueImeInput("composer", async (_snapshot, { eventId }) => {
      events.push(eventId);
    });
    await enqueueImeInput("composer", async (_snapshot, { eventId }) => {
      events.push(eventId);
    });

    expect(events).toEqual([1, 2]);
    expect(getImeInputCoordinatorState()).toMatchObject({
      status: "active",
      targetId: "composer",
      nextEventId: 3,
      pendingKeys: 0,
    });
  });

  it("drops queued work when the active target changes", async () => {
    activateImeInputTarget("first", vi.fn());
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const trace: string[] = [];
    const first = enqueueImeInput("first", async () => {
      trace.push("first-started");
      await firstStarted;
      trace.push("first-finished");
    });
    const stale = enqueueImeInput("first", async () => {
      trace.push("stale-ran");
    });

    await Promise.resolve();
    activateImeInputTarget("second", vi.fn());
    releaseFirst();
    await Promise.all([first, stale]);

    expect(trace).toEqual(["first-started", "first-finished"]);
  });

  it("rejects new and queued work after disposal", async () => {
    activateImeInputTarget("composer", vi.fn());
    disposeImeInputCoordinator();

    const result = await enqueueImeInput("composer", async () => "unexpected");

    expect(result).toBeUndefined();
    expect(getImeInputCoordinatorState()).toMatchObject({ status: "disposed" });
  });

  it("invalidates queued work when the target is released", async () => {
    activateImeInputTarget("composer", vi.fn());
    let releaseFirst!: () => void;
    const first = enqueueImeInput("composer", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const stale = enqueueImeInput("composer", async () => "unexpected");

    await Promise.resolve();
    releaseImeInputTarget("composer");
    releaseFirst();

    await Promise.all([first, stale]);
    expect(await stale).toBeUndefined();
  });

  it("does not revive work after the same target is reactivated", async () => {
    activateImeInputTarget("composer", vi.fn());
    let releaseFirst!: () => void;
    const first = enqueueImeInput("composer", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const stale = enqueueImeInput("composer", async () => "unexpected");

    await Promise.resolve();
    releaseImeInputTarget("composer");
    activateImeInputTarget("composer", vi.fn());
    releaseFirst();

    await Promise.all([first, stale]);
    expect(await stale).toBeUndefined();
  });
});
