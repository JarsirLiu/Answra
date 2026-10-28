import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStealthDocumentFlag } from "../src/hooks/useStealthDocumentFlag";

describe("useStealthDocumentFlag", () => {
  afterEach(() => {
    delete document.documentElement.dataset.stealth;
  });

  it("mirrors the enabled state and removes it on unmount", () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useStealthDocumentFlag(enabled), {
      initialProps: { enabled: false },
    });

    expect(document.documentElement).not.toHaveAttribute("data-stealth");

    rerender({ enabled: true });
    expect(document.documentElement).toHaveAttribute("data-stealth", "true");

    unmount();
    expect(document.documentElement).not.toHaveAttribute("data-stealth");
  });
});
