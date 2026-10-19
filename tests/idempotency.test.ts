import { expect, test } from "bun:test";
import { IdempotencyCache, IDEMPOTENCY_KEY_PATTERN } from "../src/idempotency.js";
import { harness, signature } from "./helpers.js";

test("IdempotencyCache validates key syntax correctly", () => {
  const cache = new IdempotencyCache();
  expect(cache.validateKey("idem-12345")).toBe(true);
  expect(cache.validateKey("user:1:job:abc_xyz.99")).toBe(true);
  expect(cache.validateKey("")).toBe(false);
  expect(cache.validateKey("key with space")).toBe(false);
  expect(cache.validateKey("a".repeat(129))).toBe(false);
  expect(cache.validateKey(null)).toBe(false);
});

test("IdempotencyCache acquire transitions from in-flight to completed", () => {
  const cache = new IdempotencyCache({ ttlMs: 1000 });
  const key = "test-key-1";

  const first = cache.acquire(key);
  expect(first.status).toBe("acquired");

  const concurrent = cache.acquire(key);
  expect(concurrent.status).toBe("in_flight");

  const headers = new Headers({ "content-type": "application/json", "x-custom": "hello" });
  const body = new TextEncoder().encode(JSON.stringify({ result: "done" }));
  cache.complete(key, 200, headers, body);

  const third = cache.acquire(key);
  expect(third.status).toBe("cached");
  if (third.status === "cached") {
    expect(third.response.statusCode).toBe(200);
    expect(new TextDecoder().decode(third.response.body)).toBe(JSON.stringify({ result: "done" }));
  }
});

test("IdempotencyCache release unlocks in-flight key", () => {
  const cache = new IdempotencyCache();
  const key = "test-release-key";

  expect(cache.acquire(key).status).toBe("acquired");
  cache.release(key);

  expect(cache.acquire(key).status).toBe("acquired");
});

test("IdempotencyCache cleans up expired records", () => {
  const cache = new IdempotencyCache();
  const now = 1000000;
  cache.acquire("expiring-key", 500, now);
  cache.complete("expiring-key", 200, new Headers(), new Uint8Array(), 500, now);

  expect(cache.size()).toBe(1);
  cache.cleanExpired(now + 600);
  expect(cache.size()).toBe(0);
});

test("app rejects invalid Idempotency-Key syntax with 400 Bad Request", async () => {
  const { app } = harness();
  const response = await app.request("/v1/echo", {
    headers: {
      "idempotency-key": "invalid key with spaces",
    },
  });
  expect(response.status).toBe(400);
  const json = await response.json();
  expect(json.error).toBe("invalid_idempotency_key");
});

test("app detects concurrent in-flight Idempotency-Key and returns 409 Conflict", async () => {
  const cache = new IdempotencyCache();
  const key = "in-flight-key-42";
  cache.acquire(key); // lock the key as in-flight

  const { app } = harness({
    idempotencyCache: cache,
  });

  const response = await app.request("/v1/echo", {
    headers: {
      "idempotency-key": key,
    },
  });
  expect(response.status).toBe(409);
  const json = await response.json();
  expect(json.error).toBe("idempotency_conflict");
});

test("repeated request with same Idempotency-Key replays cached response and bypasses upstream", async () => {
  let upstreamCalls = 0;
  const cache = new IdempotencyCache();
  const key = "agent-retry-key-999";

  const { app } = harness({
    idempotencyCache: cache,
    upstream: async (_req) => {
      upstreamCalls++;
      return Response.json({ count: upstreamCalls, message: "processed" });
    },
  });

  // 1st call: unpaid challenge
  const challenge = await app.request("/v1/action", {
    method: "POST",
    headers: { "idempotency-key": key },
  });
  expect(challenge.status).toBe(402);

  // 2nd call: paid request with idempotency key
  const sig = await signature(app, "/v1/action");
  const paidResponse = await app.request("/v1/action", {
    method: "POST",
    headers: {
      "idempotency-key": key,
      "payment-signature": sig,
    },
  });
  expect(paidResponse.status).toBe(200);
  const paidJson = await paidResponse.json();
  expect(paidJson.count).toBe(1);
  expect(upstreamCalls).toBe(1);

  // 3rd call: retried with same idempotency key (even without signature or payment)
  const replayedResponse = await app.request("/v1/action", {
    method: "POST",
    headers: {
      "idempotency-key": key,
    },
  });
  expect(replayedResponse.status).toBe(200);
  expect(replayedResponse.headers.get("idempotent-replayed")).toBe("true");
  const replayJson = await replayedResponse.json();
  expect(replayJson.count).toBe(1);
  // Upstream was NOT called again!
  expect(upstreamCalls).toBe(1);
});
