import type { ComponentType } from "react";
import { EditToolCall } from "./renderers/edit";
import { GrepToolCall } from "./renderers/grep";
import { ReadToolCall } from "./renderers/read";
import { RunCommandToolCall } from "./renderers/runCommand";
import { WriteStdinToolCall } from "./renderers/writeStdin";
import { ToolCallFallback } from "./ToolCallFallback";
import type { ToolCallRendererProps } from "./toolCallPart";

const TOOL_CALL_RENDERERS: Readonly<Record<string, ComponentType<ToolCallRendererProps>>> = {
  Read: ReadToolCall,
  Grep: GrepToolCall,
  Edit: EditToolCall,
  RunCommand: RunCommandToolCall,
  WriteStdin: WriteStdinToolCall,
};

/** Resolves by the model-facing tool name carried in events; unknown tools use the fallback. */
export function resolveToolCallRenderer(toolName: string): ComponentType<ToolCallRendererProps> {
  return TOOL_CALL_RENDERERS[toolName] ?? ToolCallFallback;
}
