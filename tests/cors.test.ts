import { describe, expect, test } from "bun:test";
import { harness, signature, testConfig } from "./helpers.js";
import { loadConfig } from "../src/config.js";

describe("CORS Support", () => {
  test("config: accepts wildcard and valid HTTP/HTTPS origins", () => {
    expect(testConfig({ CORS_ORIGIN: "*" }).corsOrigin).toBe("*");
    expect(
      testConfig({ CORS_ORIGIN: "https://agent.kite.ai" }).corsOrigin,
    ).toBe("https://agent.kite.ai");
    expect(
      testConfig({ CORS_ORIGIN: "http://localhost:3000" }).corsOrigin,
    ).toBe("http://localhost:3000");
  });

  test("config: rejects invalid origins", () => {
    expect(() => testConfig({ CORS_ORIGIN: "ftp://example.com" })).toThrow(
      /CORS_ORIGIN/,
    );
    expect(() =>
      testConfig({ CORS_ORIGIN: "https://example.com/path" }),
    ).toThrow(/CORS_ORIGIN/);
    expect(() =>
      testConfig({ CORS_ORIGIN: "https://example.com?query=1" }),
    ).toThrow(/CORS_ORIGIN/);
  });

  test("OPTIONS preflight returns 204 with CORS headers when enabled", async () => {
    const { app, events } = harness({
      env: { CORS_ORIGIN: "*" },
    });

    const response = await app.request("/v1/echo", {
      method: "OPTIONS",
      headers: {
        Origin: "https://agent.kite.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "payment-signature, content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("payment-signature");
    expect(events).toEqual([]);
  });

  test("402 Payment Required response exposes payment headers under CORS", async () => {
    const { app, events } = harness({
      env: { CORS_ORIGIN: "https://app.kite.ai" },
    });

    const response = await app.request("/v1/echo", {
      method: "GET",
      headers: {
        Origin: "https://app.kite.ai",
      },
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.kite.ai",
    );
    const exposeHeaders = (
      response.headers.get("access-control-expose-headers") ?? ""
    ).toLowerCase();
    expect(exposeHeaders).toContain("payment-required");
    expect(exposeHeaders).toContain("payment-response");
    expect(exposeHeaders).toContain("retry-after");
    expect(response.headers.get("payment-required")).toBeTruthy();
    expect(events).toEqual([]);
  });

  test("successful paid request includes CORS headers", async () => {
    const { app, events } = harness({
      env: { CORS_ORIGIN: "*" },
    });

    const sig = await signature(app);
    const response = await app.request("/v1/echo", {
      method: "GET",
      headers: {
        Origin: "https://dashboard.kite.ai",
        "payment-signature": sig,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(events).toEqual(["verify", "upstream", "settle"]);
  });

  test("when CORS_ORIGIN is unset, no CORS headers are emitted", async () => {
    const { app } = harness();

    const response = await app.request("/v1/echo", {
      method: "GET",
      headers: {
        Origin: "https://app.kite.ai",
      },
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
