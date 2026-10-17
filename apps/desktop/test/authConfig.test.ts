import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUD_API_BASE_URL,
  DEFAULT_CLOUD_SITE_BASE_URL,
  resolveCloudEndpoints,
  resolveDevOverride,
} from "../src/main/auth/config";

/** 云端地址解析：打包版不接受覆盖，开发态只允许环回 http。 */
describe("resolveCloudEndpoints", () => {
  it("ignores environment overrides in packaged builds", () => {
    expect(
      resolveCloudEndpoints(
        {
          ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8787",
          ANSWRA_CLOUD_SITE_BASE_URL: "http://127.0.0.1:5180",
        },
        { isPackaged: true },
      ),
    ).toEqual({ apiBaseUrl: DEFAULT_CLOUD_API_BASE_URL, siteBaseUrl: DEFAULT_CLOUD_SITE_BASE_URL });
  });

  it("uses defaults when nothing is set", () => {
    expect(resolveCloudEndpoints({}, { isPackaged: false })).toEqual({
      apiBaseUrl: DEFAULT_CLOUD_API_BASE_URL,
      siteBaseUrl: DEFAULT_CLOUD_SITE_BASE_URL,
    });
  });

  it("accepts loopback overrides in development", () => {
    expect(
      resolveCloudEndpoints(
        {
          ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8787/",
          ANSWRA_CLOUD_SITE_BASE_URL: "http://localhost:5180",
        },
        { isPackaged: false },
      ),
    ).toEqual({ apiBaseUrl: "http://127.0.0.1:8787", siteBaseUrl: "http://localhost:5180" });
  });
});

describe("resolveDevOverride", () => {
  it("falls back for remote or malformed overrides", () => {
    expect(resolveDevOverride("https://api.example.com", "fallback")).toBe("fallback");
    expect(resolveDevOverride("http://10.0.0.7:8787", "fallback")).toBe("fallback");
    expect(resolveDevOverride("not-a-url", "fallback")).toBe("fallback");
    expect(resolveDevOverride("   ", "fallback")).toBe("fallback");
    expect(resolveDevOverride(undefined, "fallback")).toBe("fallback");
  });
});
