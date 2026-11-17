import { describe, expect, it, vi } from "vitest";
import {
  type RemoteAuthPort,
  RemoteAuthRequiredError,
  type RemoteAuthStatus,
} from "../../../src/remote/auth/remoteAuthService";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { dispatchTuiCommand } from "../../../src/tui/commands/dispatch";
import { parseTuiCommand } from "../../../src/tui/commands/parse";
import type { TuiCommandDeps } from "../../../src/tui/commands/ports";

const SIGNED_OUT: RemoteAuthStatus = { signedIn: false, expiresAt: null, account: null };
const SIGNED_IN: RemoteAuthStatus = {
  signedIn: true,
  expiresAt: null,
  account: "tester@example.com",
};

function createRemoteAuth(status: RemoteAuthStatus): RemoteAuthPort {
  return {
    login: vi.fn(async () => status),
    status: vi.fn(async () => status),
    logout: vi.fn(async () => SIGNED_OUT),
    getAccessToken: vi.fn(async () => "access-token"),
  };
}

function createDeps(overrides: Partial<TuiCommandDeps> = {}): TuiCommandDeps {
  return {
    store: new TuiViewStore(),
    modelSettings: {} as TuiCommandDeps["modelSettings"],
    runtime: () => ({ runActive: false, activeRunActive: false, compactionActive: false }),
    getSession: () => undefined,
    activateSession: async () => {},
    createNewSession: async () => {},
    deleteSession: async () => undefined,
    compactConversation: async () => ({ status: "compacted" }),
    configureSession: async () => {},
    requestExit: () => {},
    openPanel: () => {},
    login: async () => {},
    ...overrides,
  };
}

async function runRemote(deps: TuiCommandDeps): Promise<void> {
  const invocation = parseTuiCommand("/remote");
  if (invocation === undefined) throw new Error("expected /remote invocation");
  await dispatchTuiCommand(invocation, deps);
}

describe("/remote auth hints", () => {
  it("points signed-out TUI users to /login instead of the shell auth command", async () => {
    const store = new TuiViewStore();
    const startRemoteHost = vi.fn();
    await runRemote(
      createDeps({
        store,
        remoteAuth: createRemoteAuth(SIGNED_OUT),
        startRemoteHost,
      }),
    );

    expect(startRemoteHost).not.toHaveBeenCalled();
    expect(store.getSnapshot().notifications.current?.text).toBe(
      "远程连接需要登录。请先运行 /login 登录，成功后再运行 /remote。",
    );
  });

  it("maps an expired login failure to the TUI login hint", async () => {
    const store = new TuiViewStore();
    const startRemoteHost = vi.fn(async () => {
      throw new RemoteAuthRequiredError("登录已过期，请重新运行 `answra auth login`。");
    });
    await runRemote(
      createDeps({
        store,
        remoteAuth: createRemoteAuth(SIGNED_IN),
        startRemoteHost,
      }),
    );

    expect(store.getSnapshot().notifications.current?.text).toBe(
      "登录已过期。请先运行 /login 重新登录，成功后再运行 /remote。",
    );
    expect(store.getSnapshot().localError).toBeUndefined();
  });

  it("reports missing auth support without suggesting the shell command", async () => {
    const store = new TuiViewStore();
    const startRemoteHost = vi.fn();
    await runRemote(createDeps({ store, startRemoteHost }));

    expect(startRemoteHost).not.toHaveBeenCalled();
    expect(store.getSnapshot().notifications.current?.text).toBe(
      "当前环境未配置账号登录，无法开启远程连接。",
    );
  });
});
