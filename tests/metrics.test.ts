import { expect, test } from "bun:test";
import { harness } from "./helpers.js";

test("livez reports 200 ok liveness probe without touching upstream or facilitator", async () => {
  const { app, events } = harness();
  const response = await app.request("/livez");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, status: "alive" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).not.toBeNull();
  expect(events).toEqual([]);
});

test("metrics endpoint exposes structured runtime diagnostics and stats", async () => {
  const { app, events } = harness();
  const response = await app.request("/metrics");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  const data = (await response.json()) as {
    uptime_seconds: number;
    total_requests: number;
    active_requests: number;
    status_counts: Record<string, number>;
    network: string;
    asset: string;
    memory: { rss: number; heap_used: number; heap_total: number };
  };

  expect(typeof data.uptime_seconds).toBe("number");
  expect(data.total_requests).toBeGreaterThanOrEqual(1);
  expect(typeof data.active_requests).toBe("number");
  expect(data.network).toBe("eip155:2368");
  expect(data.asset).toBe("pieUSD");
  expect(data.memory.rss).toBeGreaterThan(0);
  expect(data.memory.heap_used).toBeGreaterThan(0);
  expect(events).toEqual([]);
});

test("metrics increments total_requests and records HTTP status distributions", async () => {
  const { app } = harness();
  // Call healthz, livez, and an unknown route
  await app.request("/healthz");
  await app.request("/livez");
  await app.request("/unknown-404");

  const response = await app.request("/metrics");
  const data = (await response.json()) as {
    total_requests: number;
    status_counts: Record<string, number>;
  };

  expect(data.total_requests).toBeGreaterThanOrEqual(4);
  expect(data.status_counts["2xx"]).toBeGreaterThanOrEqual(2);
  expect(data.status_counts["4xx"]).toBeGreaterThanOrEqual(1);
  expect(data.status_counts["200"]).toBeGreaterThanOrEqual(2);
  expect(data.status_counts["404"]).toBeGreaterThanOrEqual(1);
});
