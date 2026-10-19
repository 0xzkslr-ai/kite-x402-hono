import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const baseConfig = loadConfig({
  PORT: "8402",
  PAY_TO: "0x1111111111111111111111111111111111111111",
  UPSTREAM_URL: "https://upstream.example",
  PRICE: "0.001",
  KITE_NETWORK: "testnet",
  FACILITATOR_URL: "https://facilitator.example",
  SERVICE_DESCRIPTION: "Security header test",
});

describe("security headers and not-found handling", () => {
  test("every response carries standard security headers", async () => {
    const app = createApp(baseConfig);
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-xss-protection")).toBe("0");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("unpaid 402 challenges also include security headers", async () => {
    const mockFacilitator = {
      getSupported: async () => ({
        kinds: [
          {
            network: "eip155:2368",
            scheme: "exact",
            x402Version: 2,
            extra: {},
          },
        ],
        extensions: [],
        signers: {},
      }),
    };
    const app = createApp(baseConfig, { facilitator: mockFacilitator as any });
    const res = await app.request("/v1/protected");

    expect(res.status).toBe(402);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("unknown routes return structured JSON not_found with no-store cache header", async () => {
    const app = createApp(baseConfig);
    const res = await app.request("/api/non-existent-path");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });
});
