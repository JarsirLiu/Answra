/** Unknown tool presenter: safe input/output details behind an expand. */
import { clipDetailText } from "../limits";
import type { ToolDetail, ToolPresentation, ToolPresentationInput } from "../types";
import { formatToolValue } from "../value";

export function presentFallback(context: ToolPresentationInput): ToolPresentation {
  const details: ToolDetail[] = [];
  if (context.input !== undefined || context.inputText !== undefined) {
    const clipped = clipDetailText(
      context.input === undefined ? (context.inputText ?? "") : formatToolValue(context.input),
    );
    if (clipped.text.length > 0) {
      details.push({
        kind: "text",
        label: "Input",
        text: clipped.text,
        wrap: true,
        truncated: clipped.truncated,
        totalLines: clipped.totalLines,
      });
    }
  }
  if (context.output !== undefined) {
    const clipped = clipDetailText(formatToolValue(context.output));
    if (clipped.text.length > 0) {
      details.push({
        kind: "text",
        label: "Output",
        text: clipped.text,
        wrap: true,
        truncated: clipped.truncated,
        totalLines: clipped.totalLines,
      });
    }
  }

  return {
    toolName: context.toolName,
    action: "other",
    category: "other",
    state: context.state,
    primary: context.title ?? context.toolName,
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details,
    expandable: details.length > 0,
  };
}
