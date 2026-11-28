import { describe, expect, it, vi } from "vitest";
import {
  type CredentialEntry,
  CredentialStoreUnavailableError,
  KeychainModelCredentialStore,
  TTS_CREDENTIAL_ACCOUNT_PREFIX,
  ttsCredentialAccount,
} from "../src";

function createEntry(initial: string | null = null): CredentialEntry & {
  current(): string | null;
} {
  let password = initial;
  return {
    getPassword: vi.fn(() => password),
    setPassword: vi.fn((next: string) => {
      password = next;
    }),
    deletePassword: vi.fn(() => {
      password = null;
    }),
    current: () => password,
  };
}

describe("KeychainModelCredentialStore", () => {
  it("reads and writes the model API key through the OS keychain", async () => {
    const entry = createEntry();
    const store = new KeychainModelCredentialStore({ createEntry: async () => entry });

    await expect(store.read()).resolves.toBeNull();
    await store.write("  sk-test  ");
    await expect(store.read()).resolves.toBe("sk-test");
    expect(entry.setPassword).toHaveBeenCalledWith("sk-test");

    await store.clear();
    await expect(store.read()).resolves.toBeNull();
    expect(entry.deletePassword).toHaveBeenCalledTimes(1);
  });

  it("does not delete a missing keychain entry", async () => {
    const entry = createEntry();
    const store = new KeychainModelCredentialStore({ createEntry: async () => entry });

    await store.clear();

    expect(entry.deletePassword).not.toHaveBeenCalled();
  });

  it("clears the key when writing an empty value", async () => {
    const entry = createEntry("old-key");
    const store = new KeychainModelCredentialStore({ createEntry: async () => entry });

    await store.write("   ");

    await expect(store.read()).resolves.toBeNull();
    expect(entry.setPassword).not.toHaveBeenCalled();
    expect(entry.deletePassword).toHaveBeenCalledTimes(1);
  });

  it("creates the keychain entry once across operations", async () => {
    const entry = createEntry();
    const createEntryMock = vi.fn(async () => entry);
    const store = new KeychainModelCredentialStore({ createEntry: createEntryMock });

    await store.read();
    await store.write("key");
    await store.clear();

    expect(createEntryMock).toHaveBeenCalledTimes(1);
    expect(createEntryMock).toHaveBeenCalledWith("Answra", "local-model-api-key");
  });

  it("fails closed when the keychain cannot be opened", async () => {
    const store = new KeychainModelCredentialStore({
      createEntry: async () => {
        throw new Error("keychain unavailable");
      },
    });

    await expect(store.read()).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    await expect(store.write("key")).rejects.toThrow("系统凭据库不可用");
  });
});

describe("TTS credential accounts", () => {
  it("isolates each provider from the local model key", () => {
    expect(ttsCredentialAccount("minimax")).toBe("tts-api-key:minimax");
    expect(TTS_CREDENTIAL_ACCOUNT_PREFIX).toBe("tts-api-key:");
    expect(ttsCredentialAccount("minimax")).not.toBe("local-model-api-key");
  });

  it("uses the given account when a store is created for a provider", async () => {
    const entry = createEntry("tts-key");
    const createEntryMock = vi.fn(async () => entry);
    const store = new KeychainModelCredentialStore({
      account: ttsCredentialAccount("minimax"),
      createEntry: createEntryMock,
    });

    await expect(store.read()).resolves.toBe("tts-key");
    expect(createEntryMock).toHaveBeenCalledWith("Answra", "tts-api-key:minimax");
  });
});
