import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileConversationStore } from "../../../src/core/transcript/persistence/fileConversationStore";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "answra-session-history-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file conversation store", () => {
  it("round-trips a session, lists its summary and deletes it", async () => {
    const root = await createRoot();
    const store = new FileConversationStore(root);
    await store.create("coding-1", undefined, {
      scope: "coding",
      workspaceRoot: "D:\\workspace",
    });
    await store.appendUserMessage("coding-1", {
      id: "user-1",
      role: "user",
      text: "修复登录流程",
      images: [],
      status: "complete",
    });

    const reloaded = new FileConversationStore(root);
    const snapshot = await reloaded.load("coding-1");
    expect(snapshot.messages.map((message) => message.text)).toEqual(["修复登录流程"]);

    const summaries = await reloaded.list({ scope: "coding", workspaceRoot: "D:\\workspace" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversationId: "coding-1",
      scope: "coding",
      title: "修复登录流程",
      messageCount: 1,
      workspaceRoot: "D:\\workspace",
    });

    await reloaded.delete("coding-1");
    await expect(reloaded.load("coding-1")).rejects.toThrow("会话不存在");
    expect(await reloaded.list({ scope: "coding" })).toEqual([]);
  });

  it("restores an unfinished run as interrupted without an active run", async () => {
    const root = await createRoot();
    const store = new FileConversationStore(root);
    await store.create("coding-2", undefined, { scope: "coding" });
    await store.beginRun(
      "coding-2",
      "run-1",
      {
        id: "user-1",
        role: "user",
        text: "继续实现",
        images: [],
        status: "complete",
      },
      3,
    );

    const reloaded = new FileConversationStore(root);
    const snapshot = await reloaded.load("coding-2");
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.eventRevision).toBe(0);
    expect(snapshot.messages.map((message) => [message.id, message.status])).toEqual([
      ["user-1", "complete"],
      ["run-1", "interrupted"],
    ]);
  });

  it("quarantines a corrupt file and keeps listing other sessions", async () => {
    const root = await createRoot();
    const store = new FileConversationStore(root);
    await store.create("coding-ok", undefined, { scope: "coding" });
    await writeFile(path.join(root, "broken.json"), "{", "utf8");

    expect(await store.list({ scope: "coding" })).toHaveLength(1);
    const names = await readdir(root);
    expect(names.some((name) => name.startsWith("broken.json.corrupt-"))).toBe(true);
  });

  it("keeps answer conversations in memory without writing files", async () => {
    const root = await createRoot();
    const store = new FileConversationStore(root);
    await store.create("active-exam-conversation", undefined, { scope: "answer" });
    await store.appendUserMessage("active-exam-conversation", {
      id: "user-1",
      role: "user",
      text: "这道题怎么解",
      images: [],
      status: "complete",
    });

    expect((await store.load("active-exam-conversation")).messages).toHaveLength(1);
    expect(await store.list()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a persisted conversation opened under another scope", async () => {
    const root = await createRoot();
    const store = new FileConversationStore(root);
    await store.create("coding-1", undefined, { scope: "coding" });

    await expect(store.create("coding-1", undefined, { scope: "conversation" })).rejects.toThrow(
      "会话 scope 不匹配",
    );
  });
});
