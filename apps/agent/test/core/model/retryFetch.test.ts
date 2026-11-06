import { describe, expect, it, vi } from "vitest";
import { createRetryingFetch, type RetryAttempt } from "../../../src/core/model/retryFetch";

describe("retrying fetch", () => {
  it("retries a replayable 429 with the configured delay and reports the attempt", async () => {
    const responses = [
      new Response('{"error":"limited"}', { status: 429 }),
      new Response("ok", { status: 200 }),
    ];
    const base = vi.fn(async () => responses.shift() ?? new Response("missing", { status: 500 }));
    const retries: RetryAttempt[] = [];
    const sleeps: number[] = [];
    const fetchImpl = createRetryingFetch(base, {
      rateLimit: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      onRetry: (retry) => {
        retries.push(retry);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([10]);
    expect(retries).toEqual([
      { kind: "rate-limit", attempt: 1, maxRetries: 2, delayMs: 10, statusCode: 429 },
    ]);
  });

  it("honors Retry-After before the exponential delay", async () => {
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      new Response("ok", { status: 200 }),
    ];
    const base = vi.fn(async () => responses.shift() ?? new Response("missing", { status: 500 }));
    const sleeps: number[] = [];
    const fetchImpl = createRetryingFetch(base, {
      rateLimit: { maxRetries: 2, initialDelayMs: 5_000, maxDelayMs: 60_000, jitterMs: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => undefined,
    });

    await fetchImpl("https://example.test/v1/chat", { method: "POST", body: "{}" });

    expect(sleeps).toEqual([2_000]);
  });

  it("does not retry a non-replayable request body", async () => {
    const base = vi.fn(async () => new Response("", { status: 429 }));
    const fetchImpl = createRetryingFetch(base, {
      rateLimit: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      sleep: async () => undefined,
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: new ReadableStream(),
    });

    expect(response.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("retries a transient network failure", async () => {
    let calls = 0;
    const base = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return new Response("ok", { status: 200 });
    });
    const retries: RetryAttempt[] = [];
    const fetchImpl = createRetryingFetch(base, {
      serverError: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      onRetry: (retry) => {
        retries.push(retry);
      },
      sleep: async () => undefined,
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ kind: "network-error", attempt: 1, maxRetries: 2, delayMs: 10 }]);
  });

  it("keeps retry budgets independent when a request changes failure category", async () => {
    const responses = [
      new Response("", { status: 429 }),
      new Response("", { status: 500 }),
      new Response("ok", { status: 200 }),
    ];
    const base = vi.fn(async () => responses.shift() ?? new Response("missing", { status: 500 }));
    const retries: RetryAttempt[] = [];
    const fetchImpl = createRetryingFetch(base, {
      rateLimit: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      serverError: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      onRetry: (retry) => {
        retries.push(retry);
      },
      sleep: async () => undefined,
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(3);
    expect(retries.map(({ kind, attempt, maxRetries }) => ({ kind, attempt, maxRetries }))).toEqual(
      [
        { kind: "rate-limit", attempt: 1, maxRetries: 2 },
        { kind: "server-error", attempt: 1, maxRetries: 2 },
      ],
    );
  });

  it("returns the final response after exhausting retries", async () => {
    const base = vi.fn(async () => new Response("", { status: 429 }));
    const fetchImpl = createRetryingFetch(base, {
      rateLimit: { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 },
      sleep: async () => undefined,
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("allows five rate-limit retries and reports each scheduled retry as an attempt", async () => {
    const base = vi.fn(async () => new Response("", { status: 429 }));
    const retries: RetryAttempt[] = [];
    const fetchImpl = createRetryingFetch(base, {
      onRetry: (retry) => {
        retries.push(retry);
      },
      sleep: async () => undefined,
      log: () => undefined,
    });

    const response = await fetchImpl("https://example.test/v1/chat", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(6);
    expect(retries.map(({ attempt, maxRetries }) => ({ attempt, maxRetries }))).toEqual([
      { attempt: 1, maxRetries: 5 },
      { attempt: 2, maxRetries: 5 },
      { attempt: 3, maxRetries: 5 },
      { attempt: 4, maxRetries: 5 },
      { attempt: 5, maxRetries: 5 },
    ]);
  });
});
