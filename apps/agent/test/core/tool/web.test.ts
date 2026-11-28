import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../../src/core/tool";
import { createBuiltinToolRegistry } from "../../../src/core/tool";
import { fetchWebText } from "../../../src/core/tool/builtin/web/http";
import {
  createWebTools,
  WEB_FETCH_MAX_CHARS,
  WEB_URL_MAX_CHARS,
} from "../../../src/core/tool/builtin/web/tool";
import { executeToolCall } from "../../../src/core/tool/executor/executeToolCall";
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../../../src/core/tool/names";

const BING_PAGE = `<html><body>
<li class="b_algo" data-id="1"><h2><a href="https://nodejs.org/" h="ID=SERP,1"><strong>Node</strong>.js &amp; friends</a></h2>
<div class="b_caption"><p class="b_lineclamp2">Node.js&nbsp;is opensource&nbsp;&mdash; fast.</p></div></li>
<li class="b_algo" data-id="2"><h2><a href="https://example.com/docs">Docs</a></h2>
<div class="b_caption"><p>Read the docs.</p></div></li>
</body></html>`;

function context(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    toolCallId: "web-1",
    signal,
    workspaceRoot: null,
    runId: "run-1",
    sessionId: "session-1",
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function fakeFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (async (input) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(new URL(raw));
  }) as typeof fetch;
}

describe("web tools", () => {
  it("parses Bing result blocks into numbered links with decoded snippets", async () => {
    const seen: URL[] = [];
    const { webSearch } = createWebTools({
      fetch: fakeFetch((url) => {
        seen.push(url);
        return htmlResponse(BING_PAGE);
      }),
      searchEndpoint: "https://www.bing.com/search",
    });

    const result = await webSearch.handler({ query: " node.js ", limit: 2 }, context());

    expect(seen[0]?.searchParams.get("q")).toBe("node.js");
    expect(seen[0]?.searchParams.get("count")).toBe("2");
    expect(result).toContain("搜索「node.js」（2 条）");
    expect(result).toContain("1. [Node.js & friends](https://nodejs.org/)");
    expect(result).toContain("Node.js is opensource — fast.");
    expect(result).toContain("2. [Docs](https://example.com/docs)");
  });

  it("reports an empty search result instead of inventing links", async () => {
    const { webSearch } = createWebTools({ fetch: fakeFetch(() => htmlResponse("<html></html>")) });
    const result = await webSearch.handler({ query: "nothing" }, context());
    expect(result).toContain("未找到");
  });

  it("rejects invalid search input before making a request", () => {
    const { webSearch } = createWebTools({ fetch: fakeFetch(() => htmlResponse("")) });
    expect(webSearch.validateInput?.({ query: "   " })?.code).toBe("invalid-input");
    expect(webSearch.validateInput?.({ query: "ok", limit: 0 })?.code).toBe("invalid-input");
    expect(webSearch.validateInput?.({ query: "ok", limit: 99 })?.code).toBe("invalid-input");
    expect(webSearch.validateInput?.({ query: "ok", limit: 3 })).toBeUndefined();
  });

  it("extracts readable text and drops scripts and styles", async () => {
    const { webFetch } = createWebTools({
      fetch: fakeFetch(() =>
        htmlResponse(
          "<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><h1>Hello &amp; 世界</h1><p>One&nbsp;line</p><p>Two</p></body></html>",
        ),
      ),
    });

    const result = await webFetch.handler({ url: "https://example.com/page" }, context());

    expect(result).toContain("Hello & 世界");
    expect(result).toContain("One line\nTwo");
    expect(result).not.toContain("alert(1)");
    expect(result).not.toContain("color:red");
  });

  it("bounds extracted text with max_chars", async () => {
    const { webFetch } = createWebTools({
      fetch: fakeFetch(() => htmlResponse(`<p>${"x".repeat(5000)}</p>`)),
    });
    const result = await webFetch.handler(
      { url: "https://example.com", max_chars: 1200 },
      context(),
    );
    const text = typeof result === "string" ? result : "";
    expect(text).toContain("[内容已截断]");
    expect(text.length).toBeLessThan(1500);
  });

  it("keeps multibyte page text inside the byte budget instead of failing the call", async () => {
    const { webFetch } = createWebTools({
      fetch: fakeFetch(() => htmlResponse(`<p>${"中文网页内容".repeat(15_000)}</p>`)),
    });

    const atDefault = await executeToolCall(webFetch, { url: "https://example.com/" }, context());
    expect(atDefault.success).toBe(true);
    if (atDefault.success) expect(atDefault.modelContent).toContain("[内容已截断]");

    const atLimit = await executeToolCall(
      webFetch,
      { url: "https://example.com/", max_chars: WEB_FETCH_MAX_CHARS },
      context(),
    );
    expect(atLimit.success).toBe(true);
  });

  it("rejects over-long URLs before making a request", () => {
    const { webFetch } = createWebTools({ fetch: fakeFetch(() => htmlResponse("")) });
    const longUrl = `https://example.com/${"a".repeat(WEB_URL_MAX_CHARS)}`;
    expect(webFetch.validateInput?.({ url: longUrl })?.code).toBe("invalid-input");
  });

  it("maps the request deadline to a timeout failure", async () => {
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;

    await expect(
      fetchWebText("https://example.com/", context(), {
        fetch: hangingFetch,
        timeoutMs: 5,
        maxBytes: 1024,
        maxRedirects: 5,
        userAgent: "test",
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("blocks local and private URLs before making a request", async () => {
    const { webFetch } = createWebTools({ fetch: fakeFetch(() => htmlResponse("")) });
    for (const url of [
      "http://localhost/admin",
      "http://127.0.0.1:8080/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
    ]) {
      const result = await webFetch.handler({ url }, context());
      expect(result).toMatchObject({ ok: false, code: "invalid-input" });
      expect(
        typeof result === "object" && result !== null && "message" in result ? result.message : "",
      ).toContain("不允许访问");
    }
  });

  it("blocks non-http schemes and credentialed URLs", async () => {
    const { webFetch } = createWebTools({ fetch: fakeFetch(() => htmlResponse("")) });
    for (const url of [
      "file:///C:/secret.txt",
      "javascript:alert(1)",
      "https://user:pass@example.com/",
    ]) {
      const result = await webFetch.handler({ url }, context());
      expect(result).toMatchObject({ ok: false, code: "invalid-input" });
      expect(
        typeof result === "object" && result !== null && "message" in result ? result.message : "",
      ).toMatch(/只支持 http|用户名或密码/u);
    }
  });

  it("re-validates redirect targets before following them", async () => {
    const { webFetch } = createWebTools({
      fetch: fakeFetch((url) => {
        if (url.host === "example.com") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/admin" },
          });
        }
        return htmlResponse("secret");
      }),
    });
    const result = await webFetch.handler({ url: "https://example.com/go" }, context());
    expect(result).toMatchObject({ ok: false, code: "invalid-input" });
    expect(
      typeof result === "object" && result !== null && "message" in result ? result.message : "",
    ).toContain("不允许访问");
  });

  it("maps HTTP failures and cancellation to tool failures", async () => {
    const { webFetch } = createWebTools({
      fetch: fakeFetch(() => htmlResponse("nope", 503)),
    });
    const failed = await executeToolCall(webFetch, { url: "https://example.com" }, context());
    expect(failed.success).toBe(false);
    if (!failed.success) expect(failed.error.code).toBe("handler-failed");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await executeToolCall(
      webFetch,
      { url: "https://example.com" },
      context(controller.signal),
    );
    expect(cancelled.success).toBe(false);
    if (!cancelled.success) expect(cancelled.error.code).toBe("aborted");
  });

  it("exposes both network tools while keeping them out of unauthorized tool sets", () => {
    const registry = createBuiltinToolRegistry();
    const ids = registry.list().map(({ id }) => id);
    expect(ids).toContain("web.search");
    expect(ids).toContain("web.fetch");
    const authorized = registry.authorize([], {
      signal: new AbortController().signal,
      workspaceRoot: null,
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(Object.keys(authorized)).toEqual([]);
    expect(WEB_FETCH_TOOL_NAME).toBe("WebFetch");
    expect(WEB_SEARCH_TOOL_NAME).toBe("WebSearch");
  });
});
