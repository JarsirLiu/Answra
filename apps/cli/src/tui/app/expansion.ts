/** Tool expansion state: global expand-all plus per-tool ids; no Ink or stdin. */

export interface ToolExpansionState {
  readonly all: boolean;
  readonly expandedIds: ReadonlySet<string>;
}

export function createToolExpansionState(): ToolExpansionState {
  return { all: false, expandedIds: new Set() };
}

export function isToolExpanded(state: ToolExpansionState, toolId: string): boolean {
  return state.all || state.expandedIds.has(toolId);
}

export function toggleAllTools(state: ToolExpansionState): ToolExpansionState {
  return { all: !state.all, expandedIds: new Set() };
}

export function toggleTool(state: ToolExpansionState, toolId: string): ToolExpansionState {
  if (state.all) return state;
  const expandedIds = new Set(state.expandedIds);
  if (expandedIds.has(toolId)) expandedIds.delete(toolId);
  else expandedIds.add(toolId);
  return { all: false, expandedIds };
}
