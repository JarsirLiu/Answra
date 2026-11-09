import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "../../../src/core/tool/executor/result";
import { runWithToolTimeout } from "../../../src/core/tool/executor/timeout";

async function expectToolError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "ToolExecutionError", code });
}

describe("runWithToolTimeout", () => {
  it("returns the value resolved inside the timeout", async () => {
    await expect(
      runWithToolTimeout(1_000, new AbortController().signal, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid timeout of %s",
    async (timeoutMs) => {
      await expectToolError(
        runWithToolTimeout(timeoutMs, new AbortController().signal, async () => "ok"),
        "invalid-input",
      );
    },
  );

  it("rejects before running when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectToolError(
      runWithToolTimeout(1_000, controller.signal, async () => "ok"),
      "aborted",
    );
  });

  it("aborts the handler signal when the parent signal aborts", async () => {
    const controller = new AbortController();
    let handlerSignal: AbortSignal | undefined;
    const pending = runWithToolTimeout(1_000, controller.signal, async (signal) => {
      handlerSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("inner abort")), { once: true });
      });
    });

    controller.abort();

    await expectToolError(pending, "aborted");
    expect(handlerSignal?.aborted).toBe(true);
  });

  it("preserves a ToolExecutionError used as the parent abort reason", async () => {
    const controller = new AbortController();
    const pending = runWithToolTimeout(
      1_000,
      controller.signal,
      async () => new Promise<string>(() => {}),
    );

    controller.abort(new ToolExecutionError("handler-failed", "parent stopped"));

    await expect(pending).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "handler-failed",
      message: "parent stopped",
    });
  });

  it("aborts the handler signal and rejects with timeout when the timer fires", async () => {
    let handlerSignal: AbortSignal | undefined;
    const pending = runWithToolTimeout(5, new AbortController().signal, async (signal) => {
      handlerSignal = signal;
      return new Promise<string>(() => {});
    });

    await expectToolError(pending, "timeout");
    expect(handlerSignal?.aborted).toBe(true);
  });
});
