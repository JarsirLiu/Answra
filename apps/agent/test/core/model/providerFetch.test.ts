import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalFetch } from "../../../src/core/model/providerFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLocalFetch", () => {
  it("adds the local API key without changing existing request headers", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const send = createLocalFetch("key-1");

    await send("https://example.test/v1/chat/completions", {
      headers: { "content-type": "application/json" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer key-1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("removes an inherited authorization header when the API key is empty", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const send = createLocalFetch("");

    await send("https://example.test/v1/chat/completions", {
      headers: { Authorization: "Bearer stale" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
});
