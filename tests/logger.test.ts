import { describe, expect, test } from "bun:test";
import {
  createAccessLogger,
  extractClientIp,
  formatLogEntry,
  type AccessLogEntry,
} from "../src/logger.js";
import { harness, signature } from "./helpers.js";

describe("Access Logger Unit Tests", () => {
  test("extractClientIp resolves client IP using header priority", () => {
    const h1 = new Headers({ "x-forwarded-for": "103.21.244.2, 127.0.0.1" });
    expect(extractClientIp(h1)).toBe("103.21.244.2");

    const h2 = new Headers({ "x-real-ip": "192.168.1.100" });
    expect(extractClientIp(h2)).toBe("192.168.1.100");

    const h3 = new Headers({ "cf-connecting-ip": "1.1.1.1" });
    expect(extractClientIp(h3)).toBe("1.1.1.1");

    expect(extractClientIp(new Headers())).toBeNull();
  });

  test("formatLogEntry formats JSON and dev formats correctly", () => {
    const entry: AccessLogEntry = {
      timestamp: "2026-10-19T12:00:00.000Z",
      requestId: "req-12345",
      method: "GET",
      path: "/v1/echo",
      status: 200,
      durationMs: 14.52,
      clientIp: "127.0.0.1",
      contentLength: 42,
      userAgent: "curl/8.1.2",
    };

    const jsonStr = formatLogEntry(entry, "json");
    const parsed = JSON.parse(jsonStr) as AccessLogEntry;
    expect(parsed.requestId).toBe("req-12345");
    expect(parsed.status).toBe(200);

    const devStr = formatLogEntry(entry, "dev");
    expect(devStr).toContain("GET /v1/echo");
    expect(devStr).toContain("14.52ms");
  });
});

describe("Access Logger Integration Tests with Hono app", () => {
  test("logs JSON access log entry for metered requests with logSink", async () => {
    const logs: string[] = [];
    const { app } = harness({
      env: { LOG_ENABLED: "true", LOG_FORMAT: "json" },
      logSink: (line) => logs.push(line),
      upstream: async () => Response.json({ ok: true }),
    });

    const res = await app.request("/v1/echo", {
      headers: {
        "x-request-id": "agent-metric-log-test",
        "payment-signature": await signature(app),
      },
    });

    expect(res.status).toBe(200);
    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[logs.length - 1]!) as AccessLogEntry;
    expect(parsed.path).toBe("/v1/echo");
    expect(parsed.status).toBe(200);
    expect(parsed.requestId).toBe("agent-metric-log-test");
  });

  test("skips logging for /healthz requests", async () => {
    const logs: string[] = [];
    const { app } = harness({
      env: { LOG_ENABLED: "true" },
      logSink: (line) => logs.push(line),
    });

    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(logs.length).toBe(0);
  });
});
