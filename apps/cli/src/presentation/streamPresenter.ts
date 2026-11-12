/** 非 TTY 事件呈现：把 Agent 事件投影为逐行文本，不引入 ANSI 控制序列。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { OutputPort } from "../transport/output";
import { toolFinishLine, toolStartLine } from "./toolLine";

export interface StreamPresenter {
  present(event: AgentEventEnvelope): void;
  finish(): void;
  readonly exitCode: number;
}

export function createStreamPresenter(output: OutputPort): StreamPresenter {
  let activeTextPartId: string | undefined;
  let hasOutput = false;
  let errorReported = false;
  let exitCode = 0;

  const closeText = (): void => {
    if (activeTextPartId === undefined) return;
    output.write("\n");
    activeTextPartId = undefined;
    hasOutput = true;
  };

  return {
    present(envelope) {
      const event = envelope.event;
      switch (event.type) {
        case "text-start":
          if (activeTextPartId !== undefined && activeTextPartId !== event.partId) closeText();
          activeTextPartId = event.partId;
          break;
        case "text-delta":
          if (activeTextPartId !== undefined && activeTextPartId !== event.partId) closeText();
          activeTextPartId = event.partId;
          output.write(event.delta);
          hasOutput = true;
          break;
        case "text-end":
          if (activeTextPartId === event.partId) closeText();
          break;
        case "tool-execution-started":
          closeText();
          if (hasOutput) output.write("\n");
          output.write(`[tool] ${toolStartLine(event)}\n`);
          hasOutput = true;
          break;
        case "tool-execution-finished":
          output.write(`[tool] ${toolFinishLine(event)}\n`);
          hasOutput = true;
          break;
        case "error":
          if (hasOutput) output.writeError("\n");
          output.writeError(`error: ${event.errorText}\n`);
          errorReported = true;
          exitCode = 1;
          break;
        case "retry":
          output.writeError(
            `retry: ${event.kind} ${event.attempt}/${event.maxRetries} in ${event.delayMs}ms\n`,
          );
          break;
        case "run-state-changed":
          if (event.state === "failed" || event.state === "orphaned") {
            if (exitCode !== 130) exitCode = 1;
            if (!errorReported) output.writeError("run failed\n");
            errorReported = true;
          } else if (event.state === "aborted" || event.state === "superseded") {
            exitCode = 130;
            output.writeError("cancelled\n");
          }
          break;
        default:
          break;
      }
    },
    finish() {
      closeText();
    },
    get exitCode() {
      return exitCode;
    },
  };
}
