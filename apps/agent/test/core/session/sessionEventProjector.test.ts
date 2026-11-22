/** UI 兼容投影的 run 归属：Turn 终态只能收口自己的 run，不能误伤并发 Turn。 */
import { describe, expect, it } from "vitest";
import { turnId } from "../../../src/core/session/contracts";
import { SessionEventProjector } from "../../../src/core/session/sessionEventProjector";
import { MemoryExecutionStore } from "../../../src/execution/memoryStore";
import { sessionEvent } from "./fixtures";

async function setup() {
  const store = new MemoryExecutionStore();
  const projector = new SessionEventProjector({ store });
  return { store, projector };
}

describe("SessionEventProjector run ownership", () => {
  it("finishes only the runs owned by the finished turn", async () => {
    const { store, projector } = await setup();
    await projector.apply(
      sessionEvent(
        1,
        { type: "turn-started", agentId: "general" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );
    await projector.apply(
      sessionEvent(
        2,
        { type: "step-started", stepId: "step-a", index: 0, agentId: "general" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );
    await projector.apply(
      sessionEvent(
        3,
        { type: "turn-started", agentId: "general" },
        { turnId: turnId("turn-2"), messageId: "run-b" },
      ),
    );
    await projector.apply(
      sessionEvent(
        4,
        { type: "step-started", stepId: "step-b", index: 0, agentId: "general" },
        { turnId: turnId("turn-2"), messageId: "run-b" },
      ),
    );

    // 旧逻辑用 `currentRun` 收口，会把 run-b 当成 turn-1 的 run。
    await projector.apply(
      sessionEvent(
        5,
        { type: "turn-finished", status: "aborted", reason: "cancelled" },
        { turnId: turnId("turn-1") },
      ),
    );

    expect((await store.getRun("run-a"))?.state).toBe("aborted");
    expect((await store.getRun("run-b"))?.state).toBe("running");
  });

  it("does not finish the active run when a queued turn is cancelled", async () => {
    const { store, projector } = await setup();
    await projector.apply(
      sessionEvent(
        1,
        { type: "turn-started", agentId: "general" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );

    // 排队 Turn 没有 turn-started，也就没有 run；取消时只写终态。
    await projector.apply(
      sessionEvent(
        2,
        { type: "turn-finished", status: "aborted", reason: "cancelled" },
        { turnId: turnId("turn-2") },
      ),
    );

    expect((await store.getRun("run-a"))?.state).toBe("running");
  });

  it("keeps compaction facts out of the active run event stream", async () => {
    const { store, projector } = await setup();
    await projector.apply(
      sessionEvent(
        1,
        { type: "turn-started", agentId: "general" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );

    // 自动压缩发生在 step 内部；它没有 run 归属，不能混进 assistant 的事件流。
    await projector.apply(
      sessionEvent(
        2,
        { type: "compaction-started", trigger: "auto", reason: "threshold" },
        { operationId: "operation-1" },
      ),
    );
    await projector.apply(
      sessionEvent(
        3,
        { type: "compaction-finished", summarizedMessages: 2, summary: "摘要" },
        { operationId: "operation-1" },
      ),
    );

    const events = await store.readEventsForRun("run-a");
    expect(events.filter((event) => event.event.type.startsWith("compaction-"))).toEqual([]);
    expect((await store.getRun("run-a"))?.state).toBe("running");
  });

  it("finishes the handoff target at turn end and the source at handoff", async () => {
    const { store, projector } = await setup();
    await projector.apply(
      sessionEvent(
        1,
        { type: "turn-started", agentId: "general" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );
    await projector.apply(
      sessionEvent(
        2,
        { type: "turn-handoff", fromAgentId: "general", toAgentId: "intake", task: "整理" },
        { turnId: turnId("turn-1"), messageId: "run-a" },
      ),
    );
    await projector.apply(
      sessionEvent(
        3,
        { type: "step-started", stepId: "step-b", index: 1, agentId: "intake" },
        { turnId: turnId("turn-1"), messageId: "run-b" },
      ),
    );
    await projector.apply(
      sessionEvent(
        4,
        { type: "turn-finished", status: "completed", reason: "completed" },
        { turnId: turnId("turn-1") },
      ),
    );

    expect((await store.getRun("run-a"))?.state).toBe("completed");
    expect((await store.getRun("run-b"))?.state).toBe("completed");
  });
});
