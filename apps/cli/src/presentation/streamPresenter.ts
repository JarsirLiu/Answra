/**
 * 非 TTY 事实呈现：把已结算条目与 live 增量投影为逐行文本，不引入 ANSI 控制序列。
 *
 * 正文只来自 live delta（`text` 条目已包含同一份文本，再打印会重复）；
 * 工具行与退出码只来自条目，因为它们才是 durable 事实。
 */
import type {
  AgentLiveOnlyEvent,
  LiveFrame,
  SessionFrame,
  SessionItem,
} from "@answra/shared/schema";
import type { OutputPort } from "../transport/output";
import { toolFinishLine, toolStartLine } from "./toolLine";

export interface StreamPresenter {
  presentFrame(frame: SessionFrame): void;
  presentLive(frame: LiveFrame): void;
  finish(): void;
  readonly exitCode: number;
}

export function createStreamPresenter(output: OutputPort): StreamPresenter {
  const toolNames = new Map<string, string>();
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

  const presentLiveEvent = (event: AgentLiveOnlyEvent): void => {
    switch (event.type) {
      case "text-delta":
        if (activeTextPartId !== undefined && activeTextPartId !== event.partId) closeText();
        activeTextPartId = event.partId;
        output.write(event.delta);
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

  const presentToolCall = (item: SessionItem): void => {
    if (item.payload.kind !== "tool-call") return;
    toolNames.set(item.payload.toolCallId, item.payload.toolName);
    closeText();
    if (hasOutput) output.write("\n");
    output.write(
      `[tool] ${toolStartLine({
        toolName: item.payload.toolName,
        ...(item.payload.input === undefined ? {} : { input: item.payload.input }),
      })}\n`,
    );
    hasOutput = true;
  };

  const presentToolResult = (item: SessionItem): void => {
    if (item.payload.kind !== "tool-result") return;
    const toolName = toolNames.get(item.payload.toolCallId);
    if (toolName === undefined) return;
    output.write(
      `[tool] ${toolFinishLine({
        toolName,
        outcome: item.payload.outcome,
        ...(item.payload.errorText === undefined ? {} : { errorText: item.payload.errorText }),
        ...(item.payload.durationMs === undefined ? {} : { durationMs: item.payload.durationMs }),
      })}\n`,
    );
    hasOutput = true;
  };

  const presentTurnEnd = (item: SessionItem): void => {
    if (item.payload.kind !== "turn-end") return;
    if (item.status === "failed") {
      if (exitCode !== 130) exitCode = 1;
      if (!errorReported) {
        output.writeError("run failed\n");
        errorReported = true;
      }
      return;
    }
    if (item.status === "interrupted") {
      exitCode = 130;
      output.writeError("cancelled\n");
    }
  };

  return {
    presentFrame(frame) {
      const item = frame.event.item;
      switch (item.payload.kind) {
        case "tool-call":
          presentToolCall(item);
          return;
        case "tool-result":
          presentToolResult(item);
          return;
        case "turn-end":
          presentTurnEnd(item);
          return;
        default:
          return;
      }
    },
    presentLive(frame) {
      presentLiveEvent(frame.event);
    },
    finish() {
      closeText();
    },
    get exitCode() {
      return exitCode;
    },
  };
}
