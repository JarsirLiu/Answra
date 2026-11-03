import { describe, expect, it } from "vitest";
import { RunRegistry } from "../../../src/core/run/registry";

describe("run registry", () => {
  it("tracks active runs and releases waiters when a run finishes", async () => {
    const registry = new RunRegistry();
    const controller = new AbortController();
    registry.register("run-1", controller);

    const done = registry.wait("run-1");
    expect(registry.activeCount).toBe(1);

    registry.finish("run-1");
    await expect(done).resolves.toBeUndefined();
    expect(registry.activeCount).toBe(0);
    await expect(registry.wait("run-1")).resolves.toBeUndefined();
  });

  it("cancels only the requested run without releasing its waiter early", async () => {
    const registry = new RunRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register("run-1", first);
    registry.register("run-2", second);
    const firstDone = registry.wait("run-1");

    registry.cancel("run-1");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.activeCount).toBe(2);
    let settled = false;
    void firstDone.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.finish("run-1");
    await expect(firstDone).resolves.toBeUndefined();
  });

  it("aborts every run and releases every waiter on dispose", async () => {
    const registry = new RunRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register("run-1", first);
    registry.register("run-2", second);
    const waits = [registry.wait("run-1"), registry.wait("run-2")];

    registry.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.activeCount).toBe(0);
    await expect(Promise.all(waits)).resolves.toEqual([undefined, undefined]);
  });

  it("ignores unknown run ids", async () => {
    const registry = new RunRegistry();

    registry.cancel("missing");
    registry.finish("missing");

    await expect(registry.wait("missing")).resolves.toBeUndefined();
  });
});
