import { describe, expect, it } from "vitest";
import { requestHeadersFor } from "../../../src/core/model/requestHeaders";

describe("requestHeadersFor", () => {
  it("uses the declared session header for the current conversation", () => {
    expect(requestHeadersFor({ sessionHeader: "x-opencode-session" }, "conversation-1")).toEqual({
      "x-opencode-session": "conversation-1",
    });
  });

  it("does not invent a session header when the endpoint declares none", () => {
    expect(requestHeadersFor({}, "conversation-1")).toBeUndefined();
    expect(requestHeadersFor({ sessionHeader: "  " }, "conversation-1")).toBeUndefined();
  });
});
