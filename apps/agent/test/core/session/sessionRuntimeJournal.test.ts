/** 唯一写入顺序：journal → UI 投影 → transcript → durable 观察点 → 边界快照。 */
import { describe, expect, it, vi } from "vitest";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { SessionEventProjector } from "../../../src/core/session/sessionEventProjector";
import { SessionRuntimeJournal } from "../../../src/core/session/sessionRuntimeJournal";
import { SessionTranscriptBridge } from "../../../src/core/session/transcriptBridge";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import { MemoryExecutionStore } from "../../../src/execution/memoryStore";
import { TEST_SESSION_ID, TEST_TURN_ID, userMessage } from "./fixtures";

async function setup() {
  const store = new MemoryConversationStore();
  await store.create(
    TEST_SESSION_ID,
    {
      activeAgentId: "general",
      participantAgentIds: ["general", "intake"],
      bots: [
        { id: "general", name: "General", role: "assistant" },
        { id: "intake", name: "Intake", role: "assistant" },
      ],
    },
    { scope: "conversation" },
  );
  const base = new MemorySessionJournal();
  const events = new MemoryExecutionStore();
  const projector = new SessionEventProjector({ store: events });
  const bridge = new SessionTranscriptBridge({ store });
  return { store, base, events, projector, bridge };
}

describe("SessionRuntimeJournal", () => {
  it("observes a durable event only after it is projected and written to transcript", async () => {
    const { store, base, projector, bridge } = await setup();
    const observed: Array<{ event: string; messages: number }> = [];
    const journal = new SessionRuntimeJournal({
      journal: base,
      projector,
      bridge,
      onDurableEvent: async (sessionId, event) => {
        const snapshot = await store.load(sessionId);
        observed.push({ event: event.type, messages: snapshot.messages.length });
      },
    });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", agentId: "general", input: userMessage() },
      { turnId: TEST_TURN_ID },
    );
    expect(observed[0]).toEqual({ event: "turn-queued", messages: 0 });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );

    // 观察点看到的是已落库并已写回 transcript 的状态：user + assistant 占位。
    expect(observed[1]).toEqual({ event: "turn-started", messages: 2 });
  });

  it("runs the boundary hook after the durable observer", async () => {
    const { base, projector, bridge } = await setup();
    const order: string[] = [];
    const journal = new SessionRuntimeJournal({
      journal: base,
      projector,
      bridge,
      onDurableEvent: (_id, event) => {
        order.push(`observed:${event.type}`);
      },
      onBoundary: () => {
        order.push("boundary");
      },
    });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-queued", source: "user", agentId: "general", input: userMessage() },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "aborted", reason: "cancelled" },
      { turnId: TEST_TURN_ID },
    );

    expect(order).toEqual(["observed:turn-queued", "observed:turn-finished", "boundary"]);
  });

  it("writes compaction facts through the same ordered chain", async () => {
    const { store, base, projector, bridge, events } = await setup();
    const order: string[] = [];
    const journal = new SessionRuntimeJournal({
      journal: base,
      projector,
      bridge,
      onBoundary: () => {
        order.push("boundary");
      },
    });

    await journal.appendCompaction({
      conversationId: TEST_SESSION_ID,
      operationId: "operation-1",
      event: { type: "compaction-started", trigger: "auto", reason: "threshold" },
    });

    const rows = await base.readAfter(TEST_SESSION_ID, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operationId).toBe("operation-1");
    expect(rows[0]?.event.type).toBe("compaction-started");
    // 压缩事实不写 transcript 消息，也不进入任何 assistant run 的事件流。
    expect((await store.load(TEST_SESSION_ID)).messages).toEqual([]);
    expect(await events.readEventsForRun("operation-1")).toEqual([]);
    expect(order).toEqual(["boundary"]);
  });

  it("authorizes a handoff before appending it", async () => {
    const { base, projector, bridge } = await setup();
    const authorize = vi.fn(async () => undefined);
    const journal = new SessionRuntimeJournal({
      journal: base,
      projector,
      bridge,
      authorizeHandoff: authorize,
    });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-handoff", fromAgentId: "general", toAgentId: "intake", task: "整理" },
      { turnId: TEST_TURN_ID, messageId: "assistant-1" },
    );

    expect(authorize).toHaveBeenCalledOnce();
    expect(await base.readAfter(TEST_SESSION_ID, 0)).toHaveLength(2);
  });
});
