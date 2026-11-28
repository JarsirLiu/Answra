/** 记录请求的 fetch 替身：断言 wire 格式，不触网。 */
export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
}

export function recordingFetch(respond: (call: RecordedCall) => Response): RecordingFetch {
  const calls: RecordedCall[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
