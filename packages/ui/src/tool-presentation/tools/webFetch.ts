/** WebFetch presenter: host and path as the target, character count as the result. */
import type { ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, stringField } from "../value";

export function presentWebFetch(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const url = input ? stringField(input, "url") : undefined;
  let primary = url ?? context.title ?? "web page";
  let secondary: string | undefined;
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      primary = parsed.host;
      secondary = parsed.pathname === "/" ? undefined : parsed.pathname;
    } catch {
      // 非合法 URL 交给工具自身报错，展示层保留原始输入。
    }
  }
  const output = typeof context.output === "string" ? context.output : "";
  const resultLine =
    context.state === "completed" && output.length > 0 ? `${output.length} chars` : undefined;

  return {
    toolName: context.toolName,
    action: "read",
    category: "read",
    state: context.state,
    primary,
    ...(secondary ? { secondary } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details: [],
    expandable: false,
  };
}
