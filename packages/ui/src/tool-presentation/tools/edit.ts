/** Edit presenter: file summary, +N/-N statistics, and a structured diff. */
import { editDiffDisplaySchema } from "@answra/shared/schema";
import type { ToolDetail, ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, directoryName, fileName, numberField, stringField } from "../value";

const REPLACEMENTS_PATTERN = /Replaced (\d+) occurrences?/u;
const FAILURE_PREFIX = "工具调用失败：";

export function presentEdit(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const inputPath = input
    ? (stringField(input, "file_path") ?? stringField(input, "path"))
    : undefined;
  const oldString = input ? stringField(input, "old_string") : undefined;
  const output = asRecord(context.output);
  const outputType = output ? stringField(output, "type") : undefined;
  const outputPath = output ? stringField(output, "filePath") : undefined;
  const filePath = outputPath ?? inputPath;
  const parsedDiff = output ? editDiffDisplaySchema.safeParse(output.diff) : undefined;
  const diff = parsedDiff?.success ? parsedDiff.data : undefined;
  const replacements =
    output && outputType === "edited" ? numberField(output, "replacements") : undefined;
  const legacyText = typeof context.output === "string" ? context.output : undefined;
  const legacyReplacements = legacyText?.match(REPLACEMENTS_PATTERN);
  const count = replacements ?? (legacyReplacements ? Number(legacyReplacements[1]) : undefined);
  const created = outputType === "created";
  const failure =
    context.errorText ?? (legacyText?.startsWith(FAILURE_PREFIX) === true ? legacyText : undefined);
  const details: ToolDetail[] = diff ? [{ kind: "diff", diff }] : [];
  const resultLine = created
    ? "Created file"
    : diff
      ? `Added ${diff.additions} ${diff.additions === 1 ? "line" : "lines"}, removed ${diff.deletions} ${diff.deletions === 1 ? "line" : "lines"}`
      : count !== undefined
        ? `Replaced ${count} ${count === 1 ? "occurrence" : "occurrences"}`
        : context.state === "completed"
          ? "Updated file"
          : undefined;
  const primary = filePath ? fileName(filePath) : (context.title ?? "file");
  const secondary = filePath ? directoryName(filePath) : undefined;

  return {
    toolName: context.toolName,
    action: oldString === "" ? "create" : "edit",
    category: "write",
    state: context.state,
    primary,
    ...(secondary ? { secondary } : {}),
    ...(diff ? { meta: `+${diff.additions} -${diff.deletions}` } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(failure ? { errorText: failure } : {}),
    details,
    expandable: details.length > 0,
  };
}
