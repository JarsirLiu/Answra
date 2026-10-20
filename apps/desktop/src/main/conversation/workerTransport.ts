import type { AgentCommand, AgentFrame, AgentHost, AgentTransport } from "@answra/agent";
import { startAgentHost } from "@answra/agent";

/** Adapts Electron's utility-process message port to the platform-neutral Agent host. */
export function startAgentWorker(parentPort: Electron.ParentPort): AgentHost {
  const transport: AgentTransport = {
    send: (frame: AgentFrame) => parentPort.postMessage(frame),
    onCommand: (listener) =>
      parentPort.on("message", ({ data }: Electron.MessageEvent) => {
        listener(data as AgentCommand);
      }),
    close: () => process.exit(0),
  };

  return startAgentHost({ transport });
}
