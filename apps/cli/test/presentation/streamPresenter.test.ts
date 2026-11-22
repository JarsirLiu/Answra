import type { AgentDurableEvent } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { createStreamPresenter } from "../../src/presentation/streamPresenter";
import type { OutputPort } from "../../src/transport/output";
import { liveFrame, sessionFrame } from "../frameFixtures";

function createOutput(): OutputPort & { stdout: string; stderr: string } {
  const output = {
    stdout: "",
    stderr: "",
    write(chunk: string) {
      output.stdout += chunk;
    },
    writeError(chunk: string) {
      output.stderr += chunk;
    },
  };
  return output;
}

let sequence = 0;

function frame(event: AgentDurableEvent) {
  sequence += 1;
  return sessionFrame(sequence, event, { turnId: "turn-1", messageId: "message-1" });
}

describe("stream presenter", () => {
  it("writes text deltas followed by one newline", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame({ type: "text-start", partId: "text-1" }));
    presenter.presentLive(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: "hello" },
        { messageId: "message-1" },
      ),
    );
    presenter.presentLive(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: " world" },
        { messageId: "message-1" },
      ),
    );
    presenter.presentFrame(frame({ type: "text-end", partId: "text-1" }));
    presenter.presentLive(
      liveFrame(
        { type: "text-delta", partId: "text-2", delta: "next" },
        { messageId: "message-1" },
      ),
    );
    presenter.finish();

    expect(output.stdout).toBe("hello world\nnext\n");
    expect(output.stderr).toBe("");
    expect(presenter.exitCode).toBe(0);
  });

  it("renders tool start and finish lines", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(
      frame({
        type: "tool-execution-started",
        toolCallId: "tool-1",
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
      }),
    );
    presenter.presentFrame(
      frame({
        type: "tool-execution-finished",
        toolCallId: "tool-1",
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
        result: { success: true, output: "contents" },
        durationMs: 12,
      }),
    );
    presenter.presentFrame(
      frame({
        type: "tool-execution-started",
        toolCallId: "tool-2",
        toolName: "workspace.edit",
        input: { path: "src/b.ts" },
      }),
    );
    presenter.presentFrame(
      frame({
        type: "tool-execution-finished",
        toolCallId: "tool-2",
        toolName: "workspace.edit",
        input: { path: "src/b.ts" },
        result: { success: false, errorText: "permission denied" },
        durationMs: 3,
      }),
    );

    expect(output.stdout).toBe(
      "[tool] Read(src/a.ts)\n[tool] Read ok 12ms\n\n[tool] Update(src/b.ts)\n[tool] Update failed 3ms: permission denied\n",
    );
  });

  it("reports stream errors once and exits with 1", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentLive(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: "partial" },
        { messageId: "message-1" },
      ),
    );
    presenter.presentFrame(frame({ type: "error", errorText: "boom" }));
    presenter.presentFrame(frame({ type: "turn-finished", status: "failed" }));
    presenter.finish();

    expect(output.stdout).toBe("partial\n");
    expect(output.stderr).toBe("\nerror: boom\n");
    expect(presenter.exitCode).toBe(1);
  });

  it("reports a failed turn without a prior stream error once", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame({ type: "turn-finished", status: "failed" }));
    presenter.presentFrame(frame({ type: "turn-finished", status: "failed" }));

    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("run failed\n");
    expect(presenter.exitCode).toBe(1);
  });

  it("maps aborted turns to exit code 130", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame({ type: "turn-finished", status: "aborted" }));

    expect(output.stderr).toBe("cancelled\n");
    expect(presenter.exitCode).toBe(130);
  });

  it("writes retry diagnostics to stderr without changing the exit code", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(
      frame({
        type: "retry",
        kind: "rate-limit",
        attempt: 2,
        maxRetries: 5,
        delayMs: 1_000,
      }),
    );

    expect(output.stderr).toBe("retry: rate-limit 2/5 in 1000ms\n");
    expect(presenter.exitCode).toBe(0);
  });
});
