import { describe, expect, it } from "vitest";
import {
  createToolExpansionState,
  isToolExpanded,
  toggleAllTools,
  toggleTool,
} from "../../../src/tui/app/expansion";

describe("tool expansion state", () => {
  it("toggles all tools and clears per-tool ids", () => {
    const expanded = toggleAllTools(createToolExpansionState());
    expect(expanded.all).toBe(true);
    expect(isToolExpanded(expanded, "tool-1")).toBe(true);

    const collapsed = toggleAllTools(expanded);
    expect(collapsed.all).toBe(false);
    expect(collapsed.expandedIds.size).toBe(0);
  });

  it("toggles a single tool without changing all", () => {
    const opened = toggleTool(createToolExpansionState(), "tool-1");
    expect(opened.all).toBe(false);
    expect(isToolExpanded(opened, "tool-1")).toBe(true);
    expect(isToolExpanded(opened, "tool-2")).toBe(false);

    const closed = toggleTool(opened, "tool-1");
    expect(isToolExpanded(closed, "tool-1")).toBe(false);
  });

  it("ignores per-tool toggles while all tools are expanded", () => {
    const all = toggleAllTools(createToolExpansionState());
    expect(toggleTool(all, "tool-1")).toBe(all);
  });
});
