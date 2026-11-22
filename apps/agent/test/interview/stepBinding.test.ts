import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentModelRequest } from "../../src/core/agent/definition";
import type { StepStart } from "../../src/core/session/contracts";
import { sessionId, stepId, turnId } from "../../src/core/session/contracts";
import type { InterviewAgentInput } from "../../src/interview/contracts";
import { createInterviewStepBinding } from "../../src/interview/stepBinding";

const MODEL_REQUEST: AgentModelRequest = { system: "interview", messages: [] };

function createExecutor(): {
  executor: AgentExecutor<InterviewAgentInput>;
  prepared: InterviewAgentInput[];
} {
  const prepared: InterviewAgentInput[] = [];
  return {
    prepared,
    executor: {
      startRun: async () => {
        throw new Error("not used");
      },
      prepare: async (input) => {
        prepared.push(input);
        return MODEL_REQUEST;
      },
    },
  };
}

function stepStart(overrides: Partial<StepStart> = {}): StepStart {
  return {
    sessionId: sessionId("conversation-1"),
    turnId: turnId("turn-1"),
    stepId: stepId("step-1"),
    index: 0,
    agentId: "interview.rehearsal",
    source: "reply",
    messageId: "assistant-1",
    ...overrides,
  };
}

describe("createInterviewStepBinding", () => {
  it("maps opening source to the opening input and reply source to a normal reply", async () => {
    const { executor, prepared } = createExecutor();
    const binding = createInterviewStepBinding({
      executor,
      workspaceRoot: () => "C:/workspace",
      interviewDataRoot: () => "C:/data/interview",
      profileSeed: () => null,
    });

    await binding.prepare(stepStart({ source: "opening" }), new AbortController().signal, {
      toolOutput: vi.fn(),
    });
    await binding.prepare(stepStart({ source: "reply" }), new AbortController().signal, {
      toolOutput: vi.fn(),
    });

    expect(prepared).toEqual([
      {
        conversationId: "conversation-1",
        runId: "step-1",
        workspaceRoot: "C:/workspace",
        interviewDataRoot: "C:/data/interview",
        profileSeed: null,
        opening: true,
      },
      expect.objectContaining({ opening: false }),
    ]);
  });
});
