import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  AdaptiveRateLimiter,
  createRateLimiterMiddleware,
} from "../src/rate-limiter.js";

describe("AdaptiveRateLimiter Unit Tests", () => {
  test("allows requests up to capacity and decrements remaining tokens", () => {
    const limiter = new AdaptiveRateLimiter({
      capacity: 3,
      refillRatePerSec: 1,
    });

    const res1 = limiter.consume("client-a", 1, 1000);
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);
    expect(res1.limit).toBe(3);

    const res2 = limiter.consume("client-a", 1, 1000);
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = limiter.consume("client-a", 1, 1000);
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    const res4 = limiter.consume("client-a", 1, 1000);
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
    expect(res4.resetInSec).toBeGreaterThanOrEqual(1);
  });

  test("refills tokens smoothly based on elapsed time", () => {
    const limiter = new AdaptiveRateLimiter({
      capacity: 5,
      refillRatePerSec: 2,
    });

    // Exhaust all 5 tokens at t = 0
    limiter.consume("client-b", 5, 0);
    const denied = limiter.consume("client-b", 1, 0);
    expect(denied.allowed).toBe(false);

    // Advance 1 second -> should refill 2 tokens
    const after1Sec = limiter.consume("client-b", 2, 1000);
    expect(after1Sec.allowed).toBe(true);

    // Tokens cannot exceed maximum capacity
    const after10Sec = limiter.consume("client-b", 1, 11000);
    expect(after10Sec.allowed).toBe(true);
    expect(after10Sec.remaining).toBe(4); // 5 capacity - 1 consumed = 4
  });

  test("isolates rate limit states across different clients", () => {
    const limiter = new AdaptiveRateLimiter({
      capacity: 2,
      refillRatePerSec: 1,
    });

    limiter.consume("client-1", 2, 0);
    expect(limiter.consume("client-1", 1, 0).allowed).toBe(false);

    // client-2 is unaffected
    expect(limiter.consume("client-2", 1, 0).allowed).toBe(true);
  });

  test("resets client limit on demand", () => {
    const limiter = new AdaptiveRateLimiter({
      capacity: 1,
      refillRatePerSec: 0.1,
    });

    limiter.consume("client-c", 1, 0);
    expect(limiter.consume("client-c", 1, 0).allowed).toBe(false);

    limiter.reset("client-c");
    expect(limiter.consume("client-c", 1, 0).allowed).toBe(true);
  });

  test("purges stale client buckets after cleanup interval", () => {
    const limiter = new AdaptiveRateLimiter({
      capacity: 10,
      refillRatePerSec: 1,
      cleanupIntervalMs: 5000,
    });

    limiter.consume("stale-client", 1, 0);
    expect(limiter.activeClientCount).toBe(1);

    // Call after 6 seconds -> should trigger cleanup of stale-client
    limiter.consume("fresh-client", 1, 6000);
    expect(limiter.activeClientCount).toBe(1); // stale client was purged
  });
});

describe("Rate Limiter Middleware Integration", () => {
  test("emits standard rate-limit headers and 429 when capacity exceeded", async () => {
    const app = new Hono();
    app.use(
      "*",
      createRateLimiterMiddleware({
        capacity: 2,
        refillRatePerSec: 0.5,
        keyExtractor: (c) => c.req.header("x-client-ip") ?? "anon",
      })
    );
    app.get("/test", (c) => c.text("ok"));

    const req1 = new Request("http://localhost/test", {
      headers: { "x-client-ip": "192.168.1.1" },
    });
    const res1 = await app.fetch(req1);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-ratelimit-limit")).toBe("2");
    expect(res1.headers.get("x-ratelimit-remaining")).toBe("1");

    const req2 = new Request("http://localhost/test", {
      headers: { "x-client-ip": "192.168.1.1" },
    });
    const res2 = await app.fetch(req2);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-ratelimit-remaining")).toBe("0");

    // 3rd request from same client -> 429
    const req3 = new Request("http://localhost/test", {
      headers: { "x-client-ip": "192.168.1.1" },
    });
    const res3 = await app.fetch(req3);
    expect(res3.status).toBe(429);
    expect(res3.headers.get("retry-after")).toBeDefined();
    expect(res3.headers.get("x-ratelimit-remaining")).toBe("0");

    const body = await res3.json();
    expect(body.error).toBe("too_many_requests");

    // Different client IP gets 200
    const reqOther = new Request("http://localhost/test", {
      headers: { "x-client-ip": "10.0.0.1" },
    });
    const resOther = await app.fetch(reqOther);
    expect(resOther.status).toBe(200);
  });
});
