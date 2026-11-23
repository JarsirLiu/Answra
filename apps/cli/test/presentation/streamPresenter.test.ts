import type { SessionItem } from "@answra/shared/schema";
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
const AT = "2026-11-22T00:00:00.000Z";

function frame(item: Omit<SessionItem, "seq">) {
  sequence += 1;
  return sessionFrame(sequence, item, { turnId: "turn-1", messageId: "message-1" });
}

function toolCall(toolCallId: string, toolName: string, input: unknown): Omit<SessionItem, "seq"> {
  return {
    itemId: toolCallId,
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "message-1",
    payload: { kind: "tool-call", toolCallId, toolName, input },
  };
}

function toolResult(
  toolCallId: string,
  outcome: "output" | "error" | "denied",
  extra: { output?: unknown; errorText?: string; durationMs?: number } = {},
): Omit<SessionItem, "seq"> {
  return {
    itemId: `${toolCallId}:result`,
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "message-1",
    payload: { kind: "tool-result", toolCallId, outcome, ...extra },
  };
}

function turnEnd(
  status: "complete" | "interrupted" | "failed",
  errorText?: string,
): Omit<SessionItem, "seq"> {
  return {
    itemId: "turn-1:end",
    status,
    createdAt: AT,
    turnId: "turn-1",
    payload: {
      kind: "turn-end",
      stepCount: 1,
      toolCalls: 0,
      ...(status === "interrupted"
        ? { interruption: { reason: "cancelled" as const, at: AT } }
        : {}),
      ...(errorText === undefined ? {} : { errorText }),
    },
  };
}

describe("stream presenter", () => {
  it("writes text deltas followed by one newline per part", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

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

  it("renders tool start and finish lines from items", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame(toolCall("tool-1", "workspace.read", { file_path: "src/a.ts" })));
    presenter.presentFrame(
      frame(toolResult("tool-1", "output", { output: "contents", durationMs: 12 })),
    );
    presenter.presentFrame(frame(toolCall("tool-2", "workspace.edit", { path: "src/b.ts" })));
    presenter.presentFrame(
      frame(toolResult("tool-2", "error", { errorText: "permission denied", durationMs: 3 })),
    );

    expect(output.stdout).toBe(
      "[tool] Read(src/a.ts)\n[tool] Read ok 12ms\n\n[tool] Update(src/b.ts)\n[tool] Update failed 3ms: permission denied\n",
    );
  });

  it("skips a tool result whose call line was never printed", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame(toolResult("tool-9", "output", { output: "orphan" })));

    expect(output.stdout).toBe("");
  });

  it("reports live stream errors once and keeps exit code 1", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentLive(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: "partial" },
        { messageId: "message-1" },
      ),
    );
    presenter.presentLive(
      liveFrame({ type: "error", errorText: "boom" }, { messageId: "message-1" }),
    );
    presenter.presentFrame(frame(turnEnd("failed", "boom")));
    presenter.finish();

    expect(output.stdout).toBe("partial\n");
    expect(output.stderr).toBe("\nerror: boom\n");
    expect(presenter.exitCode).toBe(1);
  });

  it("reports a failed turn without a prior stream error once", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame(turnEnd("failed", "model failed")));
    presenter.presentFrame(frame(turnEnd("failed", "model failed")));

    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("run failed\n");
    expect(presenter.exitCode).toBe(1);
  });

  it("maps interrupted turns to exit code 130", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentFrame(frame(turnEnd("interrupted")));

    expect(output.stderr).toBe("cancelled\n");
    expect(presenter.exitCode).toBe(130);
  });

  it("writes retry diagnostics to stderr without changing the exit code", () => {
    const output = createOutput();
    const presenter = createStreamPresenter(output);

    presenter.presentLive(
      liveFrame(
        {
          type: "retry",
          kind: "rate-limit",
          attempt: 2,
          maxRetries: 5,
          delayMs: 1_000,
        },
        { messageId: "message-1" },
      ),
    );

    expect(output.stderr).toBe("retry: rate-limit 2/5 in 1000ms\n");
    expect(presenter.exitCode).toBe(0);
  });
});
