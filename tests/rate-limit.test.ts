import { expect, test } from "bun:test";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { KITE_NETWORKS } from "../src/networks.js";

const baseConfig: Config = {
  payTo: "0x1111111111111111111111111111111111111111",
  chain: KITE_NETWORKS.testnet,
  upstream: "http://localhost:9999",
  price: "0.001",
  facilitatorUrl: "http://localhost:9998",
  authHeader: "authorization",
  authValue: "",
  description: "Test service",
  port: 8080,
  timeoutMs: 10000,
  maxBodyBytes: 1048576,
  rateLimitRps: 2,
  rateLimitBurst: 3,
};

test("TokenBucketRateLimiter allows burst requests up to capacity", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 2, burst: 3 });

  const r1 = limiter.consume("client1");
  expect(r1.allowed).toBe(true);
  expect(r1.remaining).toBe(2);

  const r2 = limiter.consume("client1");
  expect(r2.allowed).toBe(true);
  expect(r2.remaining).toBe(1);

  const r3 = limiter.consume("client1");
  expect(r3.allowed).toBe(true);
  expect(r3.remaining).toBe(0);

  // 4th request exceeds burst
  const r4 = limiter.consume("client1");
  expect(r4.allowed).toBe(false);
  expect(r4.remaining).toBe(0);
  expect(r4.resetSeconds).toBeGreaterThanOrEqual(1);
});

test("TokenBucketRateLimiter refills tokens over time", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 10, burst: 10 });
  const t0 = 1000000;

  // Consume all 10 tokens
  for (let i = 0; i < 10; i++) {
    expect(limiter.consume("client1", t0).allowed).toBe(true);
  }
  expect(limiter.consume("client1", t0).allowed).toBe(false);

  // 500ms later (at 10 RPS -> 5 tokens refilled)
  const t1 = t0 + 500;
  const res = limiter.consume("client1", t1);
  expect(res.allowed).toBe(true);
  expect(res.remaining).toBeGreaterThanOrEqual(3);
});

test("Hono middleware sets X-RateLimit headers and throttles exceeding requests", async () => {
  const app = createApp(baseConfig, {
    fetchUpstream: async () => new Response("ok"),
    facilitator: {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0x123" }),
      supported: async () => ({ kinds: ["exact"] }),
    } as any,
  });

  // Healthz is exempt from rate limiting
  const healthRes = await app.request("/healthz");
  expect(healthRes.status).toBe(200);
  expect(healthRes.headers.get("x-ratelimit-limit")).toBeNull();

  // Client 1 sends requests with burst = 3
  const headers = { "x-forwarded-for": "192.168.1.100" };

  const req1 = await app.request("/v1/echo", { headers });
  expect(req1.headers.get("x-ratelimit-limit")).toBe("2");
  expect(req1.headers.get("x-ratelimit-remaining")).toBe("2");

  const req2 = await app.request("/v1/echo", { headers });
  expect(req2.headers.get("x-ratelimit-remaining")).toBe("1");

  const req3 = await app.request("/v1/echo", { headers });
  expect(req3.headers.get("x-ratelimit-remaining")).toBe("0");

  // 4th request exceeds limit and gets 429
  const req4 = await app.request("/v1/echo", { headers });
  expect(req4.status).toBe(429);
  expect(req4.headers.get("retry-after")).toBeDefined();
  expect(req4.headers.get("cache-control")).toBe("no-store");
  expect(req4.headers.get("x-ratelimit-remaining")).toBe("0");

  const body = await req4.json();
  expect(body).toEqual({ error: "rate_limit_exceeded" });

  // Different client is not affected
  const otherHeaders = { "x-forwarded-for": "10.0.0.1" };
  const otherReq = await app.request("/v1/echo", { headers: otherHeaders });
  expect(otherReq.status).not.toBe(429);
  expect(otherReq.headers.get("x-ratelimit-remaining")).toBe("2");
});
