import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sessionId } from "../../../src/core/session/contracts";
import { projectSession } from "../../../src/core/session/projection";
import { recoverSession } from "../../../src/core/session/recovery";
import { SqliteSessionJournal } from "../../../src/core/session/sqliteJournal";
import { SqliteConversationStore } from "../../../src/core/transcript/persistence/sqlite/sqliteConversationStore";
import { TEST_SESSION_ID, TEST_STEP_ID, TEST_TURN_ID, userMessage } from "./fixtures";

const roots: string[] = [];
const stores: SqliteConversationStore[] = [];
const journals: SqliteSessionJournal[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "answra-session-journal-"));
  roots.push(root);
  return root;
}

function storeFor(root: string): SqliteConversationStore {
  const store = new SqliteConversationStore(root);
  stores.push(store);
  return store;
}

async function persistSession(
  root: string,
  conversationId = "session-1",
): Promise<SqliteConversationStore> {
  const store = storeFor(root);
  await store.create(conversationId, undefined, { scope: "coding" });
  await store.appendUserMessage(conversationId, {
    id: "message-1",
    role: "user",
    text: "hello",
    images: [],
    status: "complete",
  });
  return store;
}

function journalFor(root: string): SqliteSessionJournal {
  const journal = new SqliteSessionJournal(root);
  journals.push(journal);
  return journal;
}

afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SqliteSessionJournal", () => {
  it("appends sequential events and reads after a sequence", async () => {
    const root = await createRoot();
    const journal = journalFor(root);

    const first = await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );
    const second = await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    const all = await journal.readAfter(TEST_SESSION_ID, 0);
    expect(all.map((event) => event.sequence)).toEqual([1, 2]);
    expect(all[1]?.turnId).toBe("turn-1");

    const afterFirst = await journal.readAfter(TEST_SESSION_ID, 1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.event.type).toBe("turn-started");
  });

  it("persists events across a database reopen", async () => {
    const root = await createRoot();
    const first = journalFor(root);
    await first.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );
    first.close();

    const reopened = journalFor(root);
    const events = await reopened.readAfter(TEST_SESSION_ID, 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe("turn-queued");

    const next = await reopened.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    expect(next.sequence).toBe(2);
  });

  it("recovers interrupted turn and step facts after restart", async () => {
    const root = await createRoot();
    const journal = journalFor(root);
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    await journal.append(
      TEST_SESSION_ID,
      { type: "step-started", stepId: TEST_STEP_ID, index: 0, agentId: "general" },
      { turnId: TEST_TURN_ID, stepId: TEST_STEP_ID },
    );
    journal.close();

    const reopened = journalFor(root);
    const plan = await recoverSession(reopened, TEST_SESSION_ID);
    expect(plan.interruptedTurnIds).toEqual([TEST_TURN_ID]);
    expect(plan.interruptedStepIds).toEqual([TEST_STEP_ID]);

    const events = await reopened.readAfter(TEST_SESSION_ID, 0);
    const projection = projectSession(TEST_SESSION_ID, events);
    expect(projection.turns[0]?.status).toBe("failed");
    expect(projection.steps[0]?.status).toBe("failed");
  });

  it("reports the last sequence across a reopen and restarts numbering after clear", async () => {
    const root = await createRoot();
    const journal = journalFor(root);
    expect(await journal.lastSequence(TEST_SESSION_ID)).toBe(0);

    await appendQueuedTurn(journal);
    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    expect(await journal.lastSequence(TEST_SESSION_ID)).toBe(2);
    journal.close();

    const reopened = journalFor(root);
    expect(await reopened.lastSequence(TEST_SESSION_ID)).toBe(2);

    await reopened.clear(TEST_SESSION_ID);

    expect(await reopened.lastSequence(TEST_SESSION_ID)).toBe(0);
    const next = await reopened.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    expect(next.sequence).toBe(1);
  });

  it("keeps session logs isolated", async () => {
    const root = await createRoot();
    const journal = journalFor(root);

    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );

    expect(await journal.readAfter(sessionId("session-2"), 0)).toEqual([]);
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toHaveLength(1);
  });

  it("rejects an invalid read cursor", async () => {
    const root = await createRoot();
    const journal = journalFor(root);

    await expect(journal.readAfter(TEST_SESSION_ID, -1)).rejects.toThrow("非负整数");
  });

  it("reports a legacy live-only row with an actionable reset hint", async () => {
    const root = await createRoot();
    const journal = journalFor(root);
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );
    journal.close();

    // HEAD 版本真的把增量写进过 session_events，旧开发库会带上这种行。
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    const legacy = {
      schemaVersion: 1,
      eventId: "legacy-1",
      sessionId: TEST_SESSION_ID,
      turnId: TEST_TURN_ID,
      sequence: 2,
      producerId: "legacy",
      occurredAt: "2026-11-22T00:00:00.000Z",
      event: { type: "text-delta", partId: "part-1", delta: "旧" },
    };
    db.prepare(
      `INSERT INTO session_events
         (conversation_id, seq, event_id, turn_id, message_id, step_id, operation_id,
          producer_id, occurred_at, event_json)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      TEST_SESSION_ID,
      2,
      "legacy-1",
      TEST_TURN_ID,
      "legacy",
      "2026-11-22T00:00:00.000Z",
      JSON.stringify(legacy),
    );
    db.close();

    await expect(journalFor(root).readAfter(TEST_SESSION_ID, 0)).rejects.toThrow("db:reset");
  });

  it("keeps events written before the transcript session is persisted", async () => {
    const root = await createRoot();
    const journal = journalFor(root);
    await journal.append(
      TEST_SESSION_ID,
      {
        type: "turn-queued",
        source: "user",
        input: userMessage(),
        agentId: "general",
      },
      { turnId: TEST_TURN_ID },
    );

    await persistSession(root);
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toHaveLength(1);
    expect((await storeFor(root).load("session-1")).conversationId).toBe("session-1");
  });

  it("projects the turn lifecycle into session_turns", async () => {
    const root = await createRoot();
    const journal = journalFor(root);
    await appendQueuedTurn(journal);
    expect(readTurn(root)).toMatchObject({
      turn_id: "turn-1",
      seq: 1,
      source: "user",
      status: "queued",
      entry_agent_id: "general",
      active_agent_id: "general",
      input_message_id: "message-1",
    });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-started", agentId: "general" },
      { turnId: TEST_TURN_ID },
    );
    expect(readTurn(root)).toMatchObject({ status: "running", active_agent_id: "general" });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-handoff", fromAgentId: "general", toAgentId: "intake", task: "继续处理" },
      { turnId: TEST_TURN_ID, messageId: "message-2" },
    );
    expect(readTurn(root)).toMatchObject({ status: "running", active_agent_id: "intake" });

    await journal.append(
      TEST_SESSION_ID,
      { type: "turn-finished", status: "completed", reason: "completed" },
      { turnId: TEST_TURN_ID },
    );
    expect(readTurn(root)).toMatchObject({ status: "completed", finish_reason: "completed" });
  });

  it("removes journal events when the transcript session is deleted", async () => {
    const root = await createRoot();
    const store = await persistSession(root);
    const journal = journalFor(root);
    await appendQueuedTurn(journal);

    await store.delete("session-1");
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toEqual([]);
  });

  it("removes journal events when the transcript session is cleared", async () => {
    const root = await createRoot();
    const store = await persistSession(root);
    const journal = journalFor(root);
    await appendQueuedTurn(journal);

    await store.clear("session-1");
    expect(await journal.readAfter(TEST_SESSION_ID, 0)).toEqual([]);
  });
});

async function appendQueuedTurn(journal: SqliteSessionJournal): Promise<void> {
  await journal.append(
    TEST_SESSION_ID,
    {
      type: "turn-queued",
      source: "user",
      input: userMessage(),
      agentId: "general",
    },
    { turnId: TEST_TURN_ID },
  );
}

function readTurn(root: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
  try {
    return db
      .prepare(
        `SELECT turn_id, seq, source, status, finish_reason, entry_agent_id,
                active_agent_id, input_message_id
         FROM session_turns
         WHERE conversation_id = ? AND turn_id = ?`,
      )
      .get("session-1", "turn-1") as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}
