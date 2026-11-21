import { describe, expect, it } from "vitest";
import { sessionId } from "../../../src/core/session/contracts";
import { MemorySessionJournal } from "../../../src/core/session/memoryJournal";
import { TEST_SESSION_ID, TEST_TURN_ID, userMessage } from "./fixtures";

describe("MemorySessionJournal", () => {
  it("appends sequential events and reads after a sequence", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(TEST_SESSION_ID, {
      type: "turn-queued",
      source: "user",
      input: userMessage(),
      agentId: "general",
    });
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );

    const all = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(all.map((event) => event.sequence)).toEqual([1, 2]);
    expect(all[1]?.turnId).toBe("turn-1");

    const afterFirst = await journal.readAfter(TEST_SESSION_ID, 1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.event.type).toBe("turn-started");
  });

  it("returns isolated copies so callers cannot mutate the journal", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(TEST_SESSION_ID, { type: "turn-started", agentId: "general" });

    const firstRead = await journal.readAfter(TEST_SESSION_ID, 0);
    const first = firstRead[0];
    if (!first) throw new Error("expected one event");
    first.event = { type: "turn-finished", status: "failed" };

    const secondRead = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(secondRead[0]?.event).toEqual({ type: "turn-started", agentId: "general" });
  });

  it("rejects an invalid read cursor", async () => {
    const journal = new MemorySessionJournal();
    await expect(journal.readAfter(TEST_SESSION_ID, -1)).rejects.toThrow("非负整数");
  });

  it("keeps session logs isolated", async () => {
    const journal = new MemorySessionJournal();
    await journal.append(TEST_SESSION_ID, { type: "turn-started", agentId: "general" });
    expect(await journal.readAfter(sessionId("session-2"), 0)).toEqual([]);
  });
});
