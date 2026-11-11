import { describe, expect, it } from "vitest";
import {
  parseSurfaceSpec,
  SURFACE_LIMITS,
  type SurfaceNode,
  type SurfaceSpec,
} from "../src/surfaces";

function baseSpec(overrides: Partial<SurfaceSpec> = {}): SurfaceSpec {
  return {
    schemaVersion: 1,
    id: "test-surface",
    revision: 1,
    producer: "product",
    root: { type: "text", text: "hello" },
    ...overrides,
  };
}

describe("surface spec validation", () => {
  it("accepts a product surface and resolves declared button actions", () => {
    const result = parseSurfaceSpec(
      baseSpec({
        root: {
          type: "stack",
          direction: "column",
          children: [
            { type: "text", variant: "title", text: "Confirm" },
            { type: "button", label: "OK", actionId: "confirm", variant: "primary" },
          ],
        },
        actions: { confirm: { type: "invoke", command: "interview.clear" } },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects unknown primitives", () => {
    const result = parseSurfaceSpec(baseSpec({ root: { type: "html" } as unknown as SurfaceNode }));

    expect(result.ok).toBe(false);
  });

  it("rejects a button whose action is not declared", () => {
    const result = parseSurfaceSpec(
      baseSpec({ root: { type: "button", label: "OK", actionId: "confirm" } }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects more nodes than the budget", () => {
    const branch = (): SurfaceNode => ({
      type: "stack",
      direction: "column",
      children: Array.from({ length: 24 }, (_, index) => ({
        type: "text" as const,
        text: `item-${index}`,
      })),
    });
    const result = parseSurfaceSpec(
      baseSpec({
        root: {
          type: "stack",
          direction: "column",
          children: [branch(), branch(), branch()],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("node count");
  });

  it("rejects nesting deeper than the budget", () => {
    let root: SurfaceNode = { type: "text", text: "leaf" };
    for (let index = 0; index < SURFACE_LIMITS.maxDepth; index += 1) {
      root = { type: "stack", direction: "column", children: [root] };
    }
    const result = parseSurfaceSpec(baseSpec({ root }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("depth");
  });

  it("rejects too many actions and excessive text", () => {
    const actions = Object.fromEntries(
      Array.from({ length: SURFACE_LIMITS.maxActions + 1 }, (_, index) => [
        `action-${index}`,
        { type: "dismiss" as const },
      ]),
    );
    const tooManyActions = parseSurfaceSpec(baseSpec({ actions }));
    expect(tooManyActions.ok).toBe(false);

    const tooMuchText = parseSurfaceSpec(
      baseSpec({ root: { type: "text", text: "x".repeat(SURFACE_LIMITS.maxTextLength + 1) } }),
    );
    expect(tooMuchText.ok).toBe(false);
  });

  it("rejects an unknown panel in open-panel actions", () => {
    const result = parseSurfaceSpec(
      baseSpec({
        actions: {
          open: { type: "open-panel", panel: "bogus" },
        },
      } as unknown as SurfaceSpec),
    );

    expect(result.ok).toBe(false);
  });
});
