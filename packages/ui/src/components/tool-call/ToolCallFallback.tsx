import { Wrench } from "lucide-react";
import { ToolCallCard } from "./ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolOutputBlock } from "./ToolCallDetails";
import type { ToolCallRendererProps } from "./toolCallPart";
import { clipText, formatToolValue, MAX_TOOL_VALUE_CHARS } from "./toolCallPresentation";

/** Unknown tools keep the shared shell and expose their raw payload on demand. */
export function ToolCallFallback({ part }: ToolCallRendererProps) {
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const input =
    part.input !== undefined || part.inputText !== undefined
      ? clipText(formatToolValue(part.input ?? part.inputText), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const output =
    part.output !== undefined
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const hasDetails = error !== undefined || input !== undefined || output !== undefined;

  return (
    <ToolCallCard
      actionLabel="工具"
      icon={<Wrench size={13} />}
      part={part}
      primary={part.title ?? part.toolName}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {input ? (
            <ToolDetailSection label="输入">
              <ToolOutputBlock text={input.text} />
            </ToolDetailSection>
          ) : null}
          {output ? (
            <ToolDetailSection label="输出">
              <ToolOutputBlock text={output.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}
