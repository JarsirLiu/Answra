import type { SessionItem } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { sessionId as asSessionId } from "../../../src/core/session/contracts";
import {
  groupSessionTurns,
  planSessionRecovery,
  projectSessionTurns,
} from "../../../src/core/session/sessionTurns";

const AT = "2026-11-23T10:00:00.000Z";
const LATER = "2026-11-23T10:05:00.000Z";
const SESSION = asSessionId("conversation-1");
const TURN = "turn-1";

const defaults = { agentId: "general", source: "user" as const };

function base(
  seq: number,
  partial: Partial<SessionItem> & Pick<SessionItem, "itemId" | "turnId" | "payload">,
): SessionItem {
  return {
    seq,
    status: "complete",
    createdAt: AT,
    ...partial,
  } as SessionItem;
}

function userItem(seq: number, turnId = TURN, text = "写一个函数"): SessionItem {
  return base(seq, { itemId: `m-u${seq}`, turnId, payload: { kind: "user", text, images: [] } });
}

function textItem(
  seq: number,
  messageId = "m-a1",
  text = "正文",
  turnId = TURN,
  authorAgentId: string | undefined = "general",
): SessionItem {
  return base(seq, {
    itemId: `t-${seq}`,
    turnId,
    messageId,
    ...(authorAgentId === undefined ? {} : { authorAgentId }),
    payload: { kind: "text", text },
  });
}

function toolCallItem(
  seq: number,
  toolCallId = "call-1",
  messageId = "m-a1",
  turnId = TURN,
): SessionItem {
  return base(seq, {
    itemId: toolCallId,
    turnId,
    messageId,
    authorAgentId: "general",
    payload: { kind: "tool-call", toolCallId, toolName: "read_file" },
  });
}

function toolResultItem(
  seq: number,
  toolCallId = "call-1",
  messageId = "m-a1",
  turnId = TURN,
): SessionItem {
  return base(seq, {
    itemId: `${toolCallId}:result`,
    turnId,
    messageId,
    authorAgentId: "general",
    payload: { kind: "tool-result", toolCallId, outcome: "output", output: "ok" },
  });
}

function turnEndItem(
  seq: number,
  status: "complete" | "interrupted" | "failed" = "complete",
  turnId = TURN,
  extra: Partial<Extract<SessionItem["payload"], { kind: "turn-end" }>> = {},
): SessionItem {
  return base(seq, {
    itemId: `${turnId}:end`,
    turnId,
    status,
    payload: {
      kind: "turn-end",
      stepCount: 1,
      toolCalls: 0,
      ...extra,
    },
  });
}

describe("groupSessionTurns", () => {
  it("groups by turn in seq order and skips items without a turn", () => {
    const groups = groupSessionTurns([
      textItem(5),
      userItem(1),
      textItem(3),
      base(2, {
        itemId: "m-transcript",
        payload: { kind: "user", text: "面试转写", images: [] },
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.turnId).toBe(TURN);
    expect(groups[0]?.items.map((item) => item.seq)).toEqual([1, 3, 5]);
    expect(groups[0]?.userItem?.itemId).toBe("m-u1");
    expect(groups[0]?.assistantItems.map((item) => item.seq)).toEqual([3, 5]);
  });
});

describe("projectSessionTurns", () => {
  it("projects a completed turn with its input, authors and timestamps", () => {
    const projected = projectSessionTurns(
      SESSION,
      [
        userItem(1),
        textItem(2, "m-a1", "先看现有实现。"),
        toolCallItem(3),
        toolResultItem(4),
        textItem(5, "m-a1", "已加包装。"),
        turnEndItem(6, "complete"),
      ],
      { defaults },
    );

    expect(projected.sequence).toBe(6);
    expect(projected.pending).toEqual([]);
    expect(projected.activeTurnId).toBeUndefined();
    expect(projected.turns).toHaveLength(1);
    expect(projected.turns[0]).toMatchObject({
      sessionId: SESSION,
      turnId: TURN,
      source: "user",
      status: "completed",
      agentId: "general",
      assistantMessageIds: ["m-a1"],
      finishReason: "completed",
      createdAt: AT,
      startedAt: AT,
      finishedAt: AT,
    });
    expect(projected.turns[0]?.input).toMatchObject({
      id: "m-u1",
      role: "user",
      text: "写一个函数",
    });
  });

  it("maps failed and interrupted turn-end rows to their turn status", () => {
    const failed = projectSessionTurns(
      SESSION,
      [userItem(1), textItem(2), turnEndItem(3, "failed")],
      {
        defaults,
      },
    );
    const interrupted = projectSessionTurns(
      SESSION,
      [
        userItem(1),
        textItem(2),
        turnEndItem(3, "interrupted", TURN, {
          interruption: { reason: "cancelled", at: AT },
        }),
      ],
      { defaults },
    );

    expect(failed.turns[0]?.status).toBe("failed");
    expect(failed.turns[0]?.finishReason).toBe("unknown");
    expect(interrupted.turns[0]?.status).toBe("aborted");
    expect(interrupted.turns[0]?.finishReason).toBe("cancelled");
  });

  it("treats a turn with only a user item as queued and pending", () => {
    const projected = projectSessionTurns(SESSION, [userItem(1)], { defaults });

    expect(projected.turns[0]?.status).toBe("queued");
    expect(projected.pending).toEqual([TURN]);
    expect(projected.turns[0]?.input?.text).toBe("写一个函数");
  });

  it("reports the open turn as running only once it has content", () => {
    const withContent = projectSessionTurns(SESSION, [userItem(1), textItem(2)], {
      openTurnId: TURN,
      defaults,
    });
    const withoutContent = projectSessionTurns(SESSION, [userItem(1)], {
      openTurnId: TURN,
      defaults,
    });

    expect(withContent.turns[0]?.status).toBe("running");
    expect(withContent.activeTurnId).toBe(TURN);
    expect(withContent.pending).toEqual([]);
    expect(withoutContent.turns[0]?.status).toBe("queued");
    expect(withoutContent.activeTurnId).toBeUndefined();
  });

  it("treats content without turn-end and without open turn as aborted", () => {
    const projected = projectSessionTurns(SESSION, [userItem(1), textItem(2)], { defaults });

    expect(projected.turns[0]?.status).toBe("aborted");
    expect(projected.pending).toEqual([]);
  });

  it("counts distinct handoff messages inside one turn", () => {
    const projected = projectSessionTurns(
      SESSION,
      [
        userItem(1),
        textItem(2, "m-a1"),
        base(3, {
          itemId: "h-1:text",
          turnId: TURN,
          messageId: "h-1",
          authorAgentId: "general",
          audienceAgentId: "reviewer",
          payload: { kind: "text", text: "请复核" },
        }),
        base(4, {
          itemId: "h-1:text-part",
          turnId: TURN,
          messageId: "h-1",
          authorAgentId: "general",
          audienceAgentId: "reviewer",
          payload: { kind: "text", text: "继续" },
        }),
        turnEndItem(5, "complete"),
      ],
      { defaults },
    );

    expect(projected.turns[0]?.handoffCount).toBe(1);
    expect(projected.turns[0]?.activeAgentId).toBe("general");
  });

  it("falls back to the injected bot when items carry no author", () => {
    const projected = projectSessionTurns(
      SESSION,
      [
        userItem(1),
        turnEndItem(2, "interrupted", TURN, {
          interruption: { reason: "migrated", at: AT },
        }),
      ],
      { defaults: { agentId: "fallback", source: "opening" } },
    );

    expect(projected.turns[0]?.agentId).toBe("fallback");
    expect(projected.turns[0]?.source).toBe("opening");
  });
});

describe("planSessionRecovery", () => {
  it("backfills a missing tool result and closes the turn as process exit", () => {
    const plan = planSessionRecovery([userItem(1), textItem(2), toolCallItem(3)], LATER);

    expect(plan.pending).toEqual([]);
    expect(plan.closedTurnIds).toEqual([TURN]);
    expect(plan.closeItems).toEqual([
      {
        itemId: "call-1:result",
        status: "complete",
        createdAt: LATER,
        turnId: TURN,
        messageId: "m-a1",
        authorAgentId: "general",
        payload: {
          kind: "tool-result",
          toolCallId: "call-1",
          outcome: "error",
          errorText: expect.stringContaining("恢复"),
        },
      },
      {
        itemId: `${TURN}:end`,
        status: "interrupted",
        createdAt: LATER,
        turnId: TURN,
        payload: {
          kind: "turn-end",
          reason: "interrupted",
          stepCount: 0,
          toolCalls: 1,
          interruption: { reason: "process-exit", at: LATER },
        },
      },
    ]);
  });

  it("does not duplicate an already recorded tool result", () => {
    const plan = planSessionRecovery(
      [userItem(1), textItem(2), toolCallItem(3), toolResultItem(4)],
      LATER,
    );

    expect(plan.closeItems.map((draft) => draft.itemId)).toEqual([`${TURN}:end`]);
    expect(plan.closeItems[0]?.payload).toMatchObject({ toolCalls: 1 });
  });

  it("re-enqueues a turn that only has a user item", () => {
    const plan = planSessionRecovery([userItem(1)], LATER);

    expect(plan.pending).toEqual([TURN]);
    expect(plan.closeItems).toEqual([]);
    expect(plan.closedTurnIds).toEqual([]);
  });

  it("leaves a closed turn untouched", () => {
    const plan = planSessionRecovery([userItem(1), textItem(2), turnEndItem(3, "complete")], LATER);

    expect(plan.closeItems).toEqual([]);
    expect(plan.closedTurnIds).toEqual([]);
  });

  it("is idempotent once the close items are appended", () => {
    const items = [userItem(1), textItem(2), toolCallItem(3)];
    const first = planSessionRecovery(items, LATER);
    const applied: SessionItem[] = [
      ...items,
      ...first.closeItems.map((draft, index) => ({ ...draft, seq: items.length + index + 1 })),
    ];

    const second = planSessionRecovery(applied, "2026-11-23T10:10:00.000Z");

    expect(second.closeItems).toEqual([]);
    expect(second.closedTurnIds).toEqual([]);
    expect(second.pending).toEqual([]);
    const projected = projectSessionTurns(SESSION, applied, { defaults });
    expect(projected.turns[0]?.status).toBe("aborted");
    expect(projected.turns[0]?.finishReason).toBe("interrupted");
  });
});
