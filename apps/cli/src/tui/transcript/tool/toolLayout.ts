/** Tool row layout constants shared by Ink rendering and height estimation. */

export const TOOL_HEADER_WIDTH = 2;
export const TOOL_RESULT_GUTTER = "  ⎿  ";
export const TOOL_RESULT_GUTTER_WIDTH = 5;
export const TOOL_PREVIEW_TEXT_LINES = 3;
export const TOOL_PREVIEW_DIFF_LINES = 12;
export const TOOL_RUNNING_TAIL_LINES = 5;
export const TOOL_EXPANDED_TEXT_LINES = 200;
export const TOOL_EXPANDED_DIFF_LINES = 400;
export const TOOL_EXPAND_HINT = " (ctrl+o to expand)";

export function textDetailLimit(expanded: boolean, runningTail: boolean): number {
  if (expanded) return TOOL_EXPANDED_TEXT_LINES;
  if (runningTail) return TOOL_RUNNING_TAIL_LINES;
  return TOOL_PREVIEW_TEXT_LINES;
}
