/** WebSearch presenter: query as the target, hit count as the result line. */
import type { ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, stringField } from "../value";

const RESULT_LINE = /^\d+\. \[/u;

export function presentWebSearch(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const query = (input ? stringField(input, "query") : undefined) ?? context.title ?? "web";
  const output = typeof context.output === "string" ? context.output : "";
  const hits = output.split("\n").filter((line) => RESULT_LINE.test(line)).length;
  const resultLine =
    context.state === "completed" && output.length > 0 ? `${hits} results` : undefined;

  return {
    toolName: context.toolName,
    action: "search",
    category: "search",
    state: context.state,
    primary: query,
    searchTerm: "query",
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details: [],
    expandable: false,
  };
}
