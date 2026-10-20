import { describe, expect, test } from "bun:test";
import { harness, signature } from "./helpers.js";

describe("GET /stats operational metrics", () => {
  test("returns initial metrics and service metadata without contacting facilitator", async () => {
    const { app, events } = harness();
    const response = await app.request("/stats");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(events).toEqual([]);

    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.capacity.limit).toBe(64);
    expect(body.capacity.active).toBe(0);
    expect(body.traffic).toEqual({
      total: 0,
      successful: 0,
      challenges: 0,
      busy: 0,
      too_large: 0,
    });
    expect(body.network.chain).toBe("eip155:2368");
    expect(body.network.asset).toBe("pieUSD");
    expect(body.network.price).toBe("$0.001");
  });

  test("tracks payment challenges and successful settlements", async () => {
    const { app } = harness();

    // 1. Unpaid request -> triggers 402 challenge
    const res1 = await app.request("/v1/echo");
    expect(res1.status).toBe(402);

    let statsRes = await app.request("/stats");
    let stats = (await statsRes.json()) as any;
    expect(stats.traffic.total).toBe(1);
    expect(stats.traffic.challenges).toBe(1);
    expect(stats.traffic.successful).toBe(0);

    // 2. Paid request -> succeeds
    const sig = await signature(app);
    const res2 = await app.request("/v1/echo", {
      headers: { "payment-signature": sig },
    });
    expect(res2.status).toBe(200);

    statsRes = await app.request("/stats");
    stats = (await statsRes.json()) as any;
    expect(stats.traffic.total).toBe(3); // 1 unpaid challenge + 1 challenge during signature helper + 1 paid execution
    expect(stats.traffic.successful).toBe(1);
  });

  test("tracks declared oversized bodies in too_large counter", async () => {
    const { app } = harness({ env: { MAX_BODY_BYTES: "10" } });

    const response = await app.request("/v1/upload", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "a".repeat(100),
    });
    expect(response.status).toBe(413);

    const statsRes = await app.request("/stats");
    const stats = (await statsRes.json()) as any;
    expect(stats.traffic.total).toBe(1);
    expect(stats.traffic.too_large).toBe(1);
  });
});

test("settlement refusal never increments successful traffic", async () => {
  const { app } = harness({ settles: false });
  const sig = await signature(app);
  const response = await app.request("/v1/echo", {
    headers: { "payment-signature": sig },
  });
  expect(response.status).toBe(402);
  const stats = (await (await app.request("/stats")).json()) as {
    traffic: { successful: number };
  };
  expect(stats.traffic.successful).toBe(0);
});
