import type { AgentCommand, AgentFrame } from "@answra/agent";
import { ConversationRuntime } from "@answra/agent";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent worker must run as an Electron utility process");

const runtime = new ConversationRuntime((change) => write({ version: 1, type: "change", change }));

function write(frame: AgentFrame): void {
  parentPort?.postMessage(frame);
}

parentPort.on("message", ({ data }: Electron.MessageEvent) => {
  void handle(data as AgentCommand);
});

async function handle(command: AgentCommand): Promise<void> {
  try {
    let value: unknown;
    switch (command.type) {
      case "configure":
        runtime.configure(command.config);
        break;
      case "send":
        value = await runtime.send(command.conversationId, command.request);
        break;
      case "snapshot":
        value = await runtime.getSnapshot(command.conversationId);
        break;
      case "read-events":
        value = await runtime.readEventsAfter(command.conversationId, command.afterRevision);
        break;
      case "create-conversation":
        value = await runtime.createConversation(command.conversationId);
        break;
      case "cancel":
        runtime.cancel(command.runId);
        break;
      case "shutdown":
        runtime.dispose();
        process.exit(0);
        break;
    }
    write({ version: 1, type: "response", id: command.id, ok: true, value });
  } catch (error) {
    write({
      version: 1,
      type: "response",
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
