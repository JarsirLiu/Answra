import { describe, expect, it } from "vitest";
import { resolveCliCloudEndpoints, resolveDevOverride } from "../../src/config/cloudEndpoints";

const DEFAULT = "https://colorect.cloud";

describe("CLI cloud endpoints", () => {
  it("uses the official endpoints in packaged and production runtimes", () => {
    expect(
      resolveCliCloudEndpoints(
        {
          ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8080",
          ANSWRA_CLOUD_SITE_BASE_URL: "http://127.0.0.1:3100",
        },
        { isPackaged: true },
      ),
    ).toEqual({ apiBaseUrl: DEFAULT, siteBaseUrl: DEFAULT });

    expect(
      resolveCliCloudEndpoints(
        {
          ANSWRA_ENV: "production",
          ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8080",
        },
        { isPackaged: false },
      ),
    ).toEqual({ apiBaseUrl: DEFAULT, siteBaseUrl: DEFAULT });
  });

  it("allows only loopback http overrides in development", () => {
    expect(
      resolveCliCloudEndpoints(
        {
          ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8080/",
          ANSWRA_CLOUD_SITE_BASE_URL: "http://localhost:3100",
        },
        { isPackaged: false },
      ),
    ).toEqual({
      apiBaseUrl: "http://127.0.0.1:8080",
      siteBaseUrl: "http://localhost:3100",
    });

    expect(resolveDevOverride("https://example.com", DEFAULT)).toBe(DEFAULT);
    expect(resolveDevOverride("http://192.168.1.2:8080", DEFAULT)).toBe(DEFAULT);
    expect(resolveDevOverride("not a url", DEFAULT)).toBe(DEFAULT);
  });
});
