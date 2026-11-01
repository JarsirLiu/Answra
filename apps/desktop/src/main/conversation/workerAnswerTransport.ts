import type {
  AgentCommand,
  AgentFrame,
  AnswerAgentHost,
  AnswerAgentTransport,
} from "@answra/agent";
import { startAnswerAgentHost } from "@answra/agent";

/** Adapts the Electron utility process port to the answer-only Agent composition. */
export function startAnswerAgentWorker(parentPort: Electron.ParentPort): AnswerAgentHost {
  const transport: AnswerAgentTransport = {
    send: (frame: AgentFrame) => parentPort.postMessage(frame),
    onCommand: (listener) =>
      parentPort.on("message", ({ data }: Electron.MessageEvent) => {
        listener(data as AgentCommand);
      }),
    close: () => process.exit(0),
  };
  return startAnswerAgentHost({ transport });
}
