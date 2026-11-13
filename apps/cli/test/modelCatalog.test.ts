import { describe, expect, it, vi } from "vitest";
import { createOpenAiModelCatalog } from "../src/adapters/openAiModelCatalog";
import { ModelCatalogError } from "../src/model/catalog";

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  };
}

describe("createOpenAiModelCatalog", () => {
  it("requests /models with the normalized base URL and bearer token", async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ id: "b" }, { id: "a" }] }));
    const catalog = createOpenAiModelCatalog({ fetchImpl });

    await expect(
      catalog.list({ baseUrl: "http://127.0.0.1:1234/v1/", apiKey: "sk-test" }),
    ).resolves.toEqual(["a", "b"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/models",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer sk-test" },
      }),
    );
  });

  it("omits Authorization when no key is configured", async () => {
    const fetchImpl = vi.fn(async () => response({ data: [{ id: "qwen" }] }));
    const catalog = createOpenAiModelCatalog({ fetchImpl });

    await catalog.list({ baseUrl: "http://127.0.0.1:1234/v1" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/models",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("trims, deduplicates, and sorts model ids", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [{ id: " b " }, { id: "a" }, { id: "a" }, { id: "c" }] }),
    );
    const catalog = createOpenAiModelCatalog({ fetchImpl });

    await expect(catalog.list({ baseUrl: "http://127.0.0.1:1234/v1" })).resolves.toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("maps HTTP failures to a stable error", async () => {
    const fetchImpl = vi.fn(async () => response({}, 404));
    const catalog = createOpenAiModelCatalog({ fetchImpl });

    await expect(catalog.list({ baseUrl: "http://127.0.0.1:1234/v1" })).rejects.toMatchObject({
      code: "http",
      message: "读取模型列表失败：HTTP 404",
    });
  });

  it("rejects malformed payloads", async () => {
    const fetchImpl = vi.fn(async () => response({ models: [] }));
    const catalog = createOpenAiModelCatalog({ fetchImpl });

    await expect(catalog.list({ baseUrl: "http://127.0.0.1:1234/v1" })).rejects.toBeInstanceOf(
      ModelCatalogError,
    );
  });

  it("maps aborts to a timeout error", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const catalog = createOpenAiModelCatalog({ fetchImpl, timeoutMs: 1 });

    await expect(catalog.list({ baseUrl: "http://127.0.0.1:1234/v1" })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
