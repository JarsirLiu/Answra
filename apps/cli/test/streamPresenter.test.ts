import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { createStreamPresenter } from "../src/presentation/streamPresenter";
import type { OutputPort } from "../src/transport/output";

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

function envelope(event: AgentEvent): AgentEventEnvelope {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    conversationId: "conversation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    aggregateRevision: 0,
    producerId: "test",
    occurredAt: new Date().toISOString(),
    event,
  };
}

describe("stream presenter", () => {
  it("writes text deltas followed by one newline", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.present(envelope({ type: "text-start", partId: "text-1" }));
    presenter.present(envelope({ type: "text-delta", partId: "text-1", delta: "hello" }));
    presenter.present(envelope({ type: "text-delta", partId: "text-1", delta: " world" }));
    presenter.present(envelope({ type: "text-end", partId: "text-1" }));
    presenter.present(envelope({ type: "text-delta", partId: "text-2", delta: "next" }));
    presenter.finish();

    expect(output.stdout).toBe("hello world\nnext\n");
    expect(output.stderr).toBe("");
    expect(presenter.exitCode).toBe(0);
  });

  it("renders tool start and finish lines", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.present(
      envelope({
        type: "tool-execution-started",
        toolCallId: "tool-1",
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
      }),
    );
    presenter.present(
      envelope({
        type: "tool-execution-finished",
        toolCallId: "tool-1",
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
        result: { success: true, output: "contents" },
        durationMs: 12,
      }),
    );
    presenter.present(
      envelope({
        type: "tool-execution-started",
        toolCallId: "tool-2",
        toolName: "workspace.edit",
        input: { path: "src/b.ts" },
      }),
    );
    presenter.present(
      envelope({
        type: "tool-execution-finished",
        toolCallId: "tool-2",
        toolName: "workspace.edit",
        input: { path: "src/b.ts" },
        result: { success: false, errorText: "permission denied" },
        durationMs: 3,
      }),
    );

    expect(output.stdout).toBe(
      "[tool] Read(src/a.ts)\n[tool] Read ok 12ms\n\n[tool] Edit(src/b.ts)\n[tool] Edit failed 3ms: permission denied\n",
    );
  });

  it("reports stream errors once and exits with 1", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.present(envelope({ type: "text-delta", partId: "text-1", delta: "partial" }));
    presenter.present(envelope({ type: "error", errorText: "boom" }));
    presenter.present(envelope({ type: "run-state-changed", state: "failed", attempt: 1 }));
    presenter.finish();

    expect(output.stdout).toBe("partial\n");
    expect(output.stderr).toBe("\nerror: boom\n");
    expect(presenter.exitCode).toBe(1);
  });

  it("maps cancelled runs to exit code 130", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.present(envelope({ type: "run-state-changed", state: "aborted", attempt: 1 }));

    expect(output.stderr).toBe("cancelled\n");
    expect(presenter.exitCode).toBe(130);
  });

  it("writes retry diagnostics to stderr without changing the exit code", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.present(
      envelope({
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
