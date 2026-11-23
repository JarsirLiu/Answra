/** 非 TTY 事实呈现：把 durable 帧与 live 增量投影为逐行文本，不引入 ANSI 控制序列。 */
import type { AgentStreamEvent, LiveFrame, SessionFrame } from "@answra/shared/schema";
import type { OutputPort } from "../transport/output";
import { toolFinishLine, toolStartLine } from "./toolLine";

export interface StreamPresenter {
  presentFrame(frame: SessionFrame): void;
  presentLive(frame: LiveFrame): void;
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

  const present = (event: AgentStreamEvent): void => {
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
      default:
        break;
    }
  };

  return {
    presentFrame(frame) {
      const event = frame.event;
      if (event.type === "session-item") return;
      switch (event.type) {
        case "turn-finished":
          if (event.status === "failed") {
            if (exitCode !== 130) exitCode = 1;
            if (!errorReported) output.writeError("run failed\n");
            errorReported = true;
            return;
          }
          if (event.status === "aborted") {
            exitCode = 130;
            output.writeError("cancelled\n");
          }
          return;
        case "turn-queued":
        case "turn-started":
        case "turn-handoff":
        case "compaction-started":
        case "compaction-finished":
        case "compaction-failed":
        case "compaction-aborted":
        case "step-started":
        case "step-finished":
        case "context-usage-changed":
        case "part-state-changed":
          return;
        default:
          present(event);
      }
    },
    presentLive(frame) {
      present(frame.event);
    },
    finish() {
      closeText();
    },
    get exitCode() {
      return exitCode;
    },
  };
}
