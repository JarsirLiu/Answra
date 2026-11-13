import type { ConversationSnapshot } from "@answra/shared";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSession } from "../src/session/codingSession";
import { TUI_HELP_LINES } from "../src/tui/commands";
import { runInkTui } from "../src/tui/runTui";
import { TuiViewStore } from "../src/tui/viewStore";

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock("ink", () => ({
  Box: () => null,
  Text: () => null,
  render: renderMock,
  useApp: () => ({ exit: vi.fn() }),
  useInput: () => {},
  useWindowSize: () => ({ columns: 80, rows: 24 }),
}));

interface AppProps {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  selectionStore?: unknown;
  onCopySelection?: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
}

interface RenderResult {
  props: AppProps;
  options: Record<string, unknown>;
  finish: () => void;
}

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 0,
  messages: [],
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createSession() {
  const sent: string[] = [];
  const waits: Array<() => void> = [];
  const session = {
    open: vi.fn(async () => snapshot),
    send: vi.fn(async (text: string) => {
      sent.push(text);
      return `run-${sent.length}`;
    }),
    wait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          waits.push(resolve);
        }),
    ),
    cancel: vi.fn(),
    clear: vi.fn(async () => snapshot),
    close: vi.fn(),
  } as unknown as CodingSession;
  return { session, sent, waits };
}

async function start(
  session: CodingSession,
  store: TuiViewStore,
  altScreen = false,
): Promise<RenderResult> {
  let props: AppProps | undefined;
  let options: Record<string, unknown> | undefined;
  let finish: (() => void) | undefined;
  renderMock.mockImplementation(
    (element: ReactElement<AppProps>, renderOptions: Record<string, unknown>) => {
      props = element.props;
      options = renderOptions;
      return {
        waitUntilExit: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      };
    },
  );
  void runInkTui({
    session,
    store,
    botName: "coding.engineer",
    model: "test-model",
    workspaceRoot: "D:\\workspace",
    altScreen,
  });
  await tick();
  if (!props || !options || !finish) throw new Error("TUI did not render");
  return { props, options, finish };
}

describe("runInkTui", () => {
  beforeEach(() => {
    renderMock.mockReset();
  });

  it("queues prompts submitted while a run is active", async () => {
    const { session, sent, waits } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    expect(sent).toEqual(["first"]);
    expect(store.getSnapshot().phase).toBe("running");

    props.onSubmit("second");
    await tick();
    expect(sent).toEqual(["first"]);
    expect(store.getSnapshot()).toMatchObject({ queued: 1, phase: "running" });

    waits.shift()?.();
    await tick();
    await tick();
    expect(sent).toEqual(["first", "second"]);
    expect(store.getSnapshot().queued).toBe(0);

    waits.shift()?.();
    await tick();
    expect(store.getSnapshot().phase).toBe("idle");
    finish();
    store.dispose();
  });

  it("handles help and clear without sending a prompt", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("/help");
    await tick();
    expect(store.getSnapshot().notice).toEqual(TUI_HELP_LINES);

    props.onSubmit("/clear");
    await tick();
    expect(session.clear).toHaveBeenCalledTimes(1);
    expect(session.send).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      notice: ["会话已清除。"],
      view: { eventRevision: 0, messages: [] },
    });

    finish();
    store.dispose();
  });

  it("wires selection frame commits when the alternate screen is enabled", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, options, finish } = await start(session, store, true);

    expect(options.alternateScreen).toBe(true);
    expect(typeof options.onRender).toBe("function");
    expect(props.selectionStore).toBeDefined();
    expect(props.onCopySelection).toBeTypeOf("function");
    expect(props.onSelectAll).toBeTypeOf("function");
    expect(props.onClearSelection).toBeTypeOf("function");
    const onRender = options.onRender as (metrics: { renderTime: number }) => void;
    expect(() => onRender({ renderTime: 1 })).not.toThrow();

    finish();
    store.dispose();
  });

  it("keeps terminal-native selection and copy outside the alternate screen", async () => {
    const { session } = createSession();
    const store = new TuiViewStore();
    const { props, options, finish } = await start(session, store);

    expect(options.alternateScreen).toBe(false);
    expect(options.onRender).toBeUndefined();
    expect(props.selectionStore).toBeUndefined();
    expect(props.onCopySelection).toBeUndefined();
    expect(props.onSelectAll).toBeUndefined();
    expect(props.onClearSelection).toBeUndefined();

    finish();
    store.dispose();
  });

  it("clears queued prompts when the active run is cancelled", async () => {
    const { session, waits } = createSession();
    const store = new TuiViewStore();
    const { props, finish } = await start(session, store);

    props.onSubmit("first");
    await tick();
    props.onSubmit("second");
    await tick();
    props.onCancel();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ queued: 0, phase: "cancelling" });

    waits.shift()?.();
    await tick();
    await tick();
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().phase).toBe("idle");
    finish();
    store.dispose();
  });
});
