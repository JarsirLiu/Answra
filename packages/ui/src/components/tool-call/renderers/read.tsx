import { FileText } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import type { ToolCallRendererProps } from "../toolCallPart";
import { asRecord, fileName, stringField } from "../toolCallPresentation";

/** Read: summary only; file contents stay out of the transcript UI. */
export function ReadToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const path = input ? stringField(input, "file_path") : undefined;

  return (
    <ToolCallCard
      actionLabel="Read"
      icon={<FileText size={13} />}
      part={part}
      primary={path ? fileName(path) : (part.title ?? "文件")}
    />
  );
}
