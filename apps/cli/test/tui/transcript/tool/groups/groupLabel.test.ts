import type { ToolPresentation } from "@answra/ui/tool-presentation";
import { describe, expect, it } from "vitest";
import { groupLabel } from "../../../../../src/tui/transcript/tool/groups/groupLabel";

function presentation(
  category: ToolPresentation["category"],
  primary: string,
  secondary?: string,
  state: ToolPresentation["state"] = "completed",
): ToolPresentation {
  return {
    toolName: "tool",
    action: category === "search" ? "search" : "read",
    category,
    state,
    primary,
    ...(secondary === undefined ? {} : { secondary }),
    details: [],
    expandable: false,
  };
}

describe("tool group labels", () => {
  it("orders search, read, and list regardless of arrival order", () => {
    const label = groupLabel(
      [
        presentation("read", "a.ts", "src"),
        presentation("search", "needle", "src"),
        presentation("list", "src"),
      ],
      false,
    );
    expect(label.label).toBe("Searched 1 pattern, read 1 file, listed 1 directory");
  });

  it("uses present tense while the group is running", () => {
    const label = groupLabel(
      [presentation("read", "a.ts", "src"), presentation("search", "needle")],
      true,
    );
    expect(label.label).toBe("Searching 1 pattern, reading 1 file");
  });

  it("counts read files by directory and name", () => {
    const label = groupLabel(
      [presentation("read", "a.ts", "src"), presentation("read", "a.ts", "test")],
      false,
    );
    expect(label.label).toBe("Read 2 files");
  });

  it("reports the current target while running", () => {
    const label = groupLabel(
      [presentation("read", "a.ts", "src"), presentation("search", "needle", "src")],
      true,
    );
    expect(label.currentTarget).toBe("needle");
  });

  it("prefers the running target over a later completed target", () => {
    const label = groupLabel(
      [presentation("read", "a.ts", "src", "running"), presentation("search", "needle", "src")],
      true,
    );
    expect(label.currentTarget).toBe("src/a.ts");
  });
});
