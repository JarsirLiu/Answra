import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { SelectableText, SelectionContext } from "../src/tui/components/SelectableText";
import { TuiSelectionStore } from "../src/tui/interaction/selectionStore";

function nextFrame(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SelectableText", () => {
  it("falls back to plain text without a selection store", async () => {
    const instance = render(<SelectableText>plain text</SelectableText>);
    await nextFrame();
    expect(instance.lastFrame()).toContain("plain text");
    instance.unmount();
  });

  it("registers rendered lines and applies inverse video to the selection", async () => {
    const store = new TuiSelectionStore();
    store.begin({ row: 0, col: 0 });
    store.extend({ row: 0, col: 4 });

    const instance = render(
      <SelectionContext.Provider value={store}>
        <SelectableText>hello world</SelectableText>
      </SelectionContext.Provider>,
    );
    await nextFrame();
    store.commitFrame();

    expect(store.hasLine(0)).toBe(true);
    expect(store.getSelectedText()).toBe("hello");
    expect(instance.lastFrame()).toContain("\x1b[7m");
    instance.unmount();
  });

  it("uses the absolute screen column for left-padded lines", async () => {
    const store = new TuiSelectionStore();
    store.begin({ row: 0, col: 2 });
    store.extend({ row: 0, col: 3 });

    const instance = render(
      <SelectionContext.Provider value={store}>
        <Box paddingLeft={2}>
          <SelectableText>hi</SelectableText>
        </Box>
      </SelectionContext.Provider>,
    );
    await nextFrame();
    store.commitFrame();

    expect(store.hasLine(0)).toBe(true);
    expect(store.getSelectedText()).toBe("hi");
    instance.unmount();
  });

  it("registers each explicit line at its own row", async () => {
    const store = new TuiSelectionStore();
    const instance = render(
      <SelectionContext.Provider value={store}>
        <SelectableText>{"ab\ncd"}</SelectableText>
      </SelectionContext.Provider>,
    );
    await nextFrame();
    store.commitFrame();
    store.selectAll();

    expect(store.hasLine(0)).toBe(true);
    expect(store.hasLine(1)).toBe(true);
    expect(store.getSelectedText()).toBe("ab\ncd");
    instance.unmount();
  });
});
