import { expect, test } from "bun:test";
import { IdempotencyCache } from "../src/idempotency.js";
import { harness, signature } from "./helpers.js";
import { PaymentNonceReplayGuard } from "../src/nonce-guard.js";

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

  const headers = new Headers({
    "content-type": "application/json",
    "x-custom": "hello",
  });
  const body = new TextEncoder().encode(JSON.stringify({ result: "done" }));
  cache.complete(key, 200, headers, body);

  const third = cache.acquire(key);
  expect(third.status).toBe("cached");
  if (third.status === "cached") {
    expect(third.response.statusCode).toBe(200);
    expect(new TextDecoder().decode(third.response.body)).toBe(
      JSON.stringify({ result: "done" }),
    );
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
  cache.complete(
    "expiring-key",
    200,
    new Headers(),
    new Uint8Array(),
    500,
    now,
  );

  expect(cache.size()).toBe(1);
  cache.cleanExpired(now + 600);
  expect(cache.size()).toBe(0);
});

test("request fingerprints remain bound during execution and after completion", () => {
  const cache = new IdempotencyCache();
  const now = 1000000;
  expect(cache.acquire("bound", 1000, now, "original").status).toBe("acquired");
  expect(cache.acquire("bound", 1000, now, "changed").status).toBe("conflict");
  expect(cache.acquire("bound", 1000, now, "original").status).toBe(
    "in_flight",
  );
  cache.complete("bound", 200, new Headers(), new Uint8Array(), 1000, now);
  cache.release("bound");
  expect(cache.acquire("bound", 1000, now, "changed").status).toBe("conflict");
  expect(cache.acquire("bound", 1000, now, "original").status).toBe("cached");
  expect(cache.acquire("bound", 1000, now + 1001, "changed").status).toBe(
    "acquired",
  );
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
  const key = "in-flight-key-42";
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, events } = harness({
    upstream: async () => {
      entered();
      await pending;
      return new Response("done");
    },
  });
  const headers = {
    "idempotency-key": key,
    "payment-signature": await signature(app),
  };
  const first = app.request("/v1/echo", { headers });
  try {
    await started;
    const response = await app.request("/v1/echo", { headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "idempotency_conflict" });
    expect(events).toEqual(["verify", "upstream"]);
  } finally {
    release();
    expect((await first).status).toBe(200);
  }
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

  // A retry must present the same payment credential and request.
  const replayedResponse = await app.request("/v1/action", {
    method: "POST",
    headers: {
      "idempotency-key": key,
      "payment-signature": sig,
    },
  });
  expect(replayedResponse.status).toBe(200);
  expect(replayedResponse.headers.get("idempotent-replayed")).toBe("true");
  const replayJson = await replayedResponse.json();
  expect(replayJson.count).toBe(1);
  // Upstream was NOT called again!
  expect(upstreamCalls).toBe(1);
});

test.each([undefined, "not-a-payment"])(
  "a matching user key cannot disclose a cached response without its payment credential (%s)",
  async (credential) => {
    const { app, events } = harness();
    const key = "private-result";
    const sig = await signature(app);
    expect(
      (
        await app.request("/v1/echo", {
          headers: { "idempotency-key": key, "payment-signature": sig },
        })
      ).status,
    ).toBe(200);
    const response = await app.request("/v1/other?user=another", {
      headers: {
        "idempotency-key": key,
        ...(credential ? { "payment-signature": credential } : {}),
      },
    });
    expect(response.status).toBe(402);
    expect(response.headers.get("idempotent-replayed")).toBeNull();
    expect(await response.text()).not.toContain("protected response");
    expect(events).toEqual(["verify", "upstream", "settle"]);
  },
);

test("different payment credentials with the same user key have separate responses", async () => {
  let calls = 0;
  const { app, events } = harness({
    upstream: async () => Response.json({ call: ++calls }),
  });
  const first = await signature(app);
  const payload = JSON.parse(Buffer.from(first, "base64").toString());
  payload.payload.authorization.nonce = `0x${"11".repeat(32)}`;
  const second = Buffer.from(JSON.stringify(payload)).toString("base64");
  for (const [sig, call] of [
    [first, 1],
    [second, 2],
    [first, 1],
  ] as const) {
    const response = await app.request("/v1/echo", {
      headers: { "idempotency-key": "same-key", "payment-signature": sig },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ call });
  }
  expect(events).toEqual([
    "verify",
    "upstream",
    "settle",
    "verify",
    "upstream",
    "settle",
  ]);
});

test.each([
  {
    name: "method",
    path: "/v1/action?x=1",
    method: "PUT",
    body: "original",
    accept: "application/json",
  },
  {
    name: "path",
    path: "/v1/other?x=1",
    method: "POST",
    body: "original",
    accept: "application/json",
  },
  {
    name: "query",
    path: "/v1/action?x=2",
    method: "POST",
    body: "original",
    accept: "application/json",
  },
  {
    name: "body",
    path: "/v1/action?x=1",
    method: "POST",
    body: "changed",
    accept: "application/json",
  },
  {
    name: "header",
    path: "/v1/action?x=1",
    method: "POST",
    body: "original",
    accept: "text/plain",
  },
])(
  "reusing a payment and key with a changed $name returns conflict",
  async ({ path, method, body, accept }) => {
    const { app, events } = harness();
    const headers = {
      "idempotency-key": "bound-request",
      "payment-signature": await signature(app),
      accept: "application/json",
    };
    expect(
      (
        await app.request("/v1/action?x=1", {
          method: "POST",
          body: "original",
          headers,
        })
      ).status,
    ).toBe(200);
    const response = await app.request(path, {
      method,
      body,
      headers: { ...headers, accept },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "idempotency_conflict" });
    expect(events).toEqual(["verify", "upstream", "settle"]);
    const retry = await app.request("/v1/action?x=1", {
      method: "POST",
      body: "original",
      headers,
    });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
  },
);

test("an exact paid retry uses cache before nonce replay rejection", async () => {
  const { app, events } = harness({
    nonceGuard: new PaymentNonceReplayGuard(),
  });
  const headers = {
    "idempotency-key": "paid-retry",
    "payment-signature": await signature(app),
  };
  const first = await app.request("/v1/echo", { headers });
  const retry = await app.request("/v1/echo", { headers });
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(retry.headers.get("idempotent-replayed")).toBe("true");
  expect(retry.headers.get("payment-response")).toBe(
    first.headers.get("payment-response"),
  );
  expect(await retry.text()).toBe(await first.text());
  expect(events).toEqual(["verify", "upstream", "settle"]);
  const changedKey = await app.request("/v1/echo", {
    headers: { ...headers, "idempotency-key": "other-key" },
  });
  expect(changedKey.status).toBe(402);
  expect(events).toEqual(["verify", "upstream", "settle"]);
});

test("an exact retry may use a new request ID and regenerated wrapper headers", async () => {
  const { app, events } = harness({ env: { CORS_ORIGIN: "*" } });
  const headers = {
    "idempotency-key": "traced-retry",
    "payment-signature": await signature(app),
    origin: "https://app.example",
  };
  expect(
    (
      await app.request("/v1/echo", {
        headers: { ...headers, "x-request-id": "first" },
      })
    ).status,
  ).toBe(200);
  const retry = await app.request("/v1/echo", {
    headers: { ...headers, "x-request-id": "retry" },
  });
  expect(retry.status).toBe(200);
  expect(retry.headers.get("idempotent-replayed")).toBe("true");
  expect(retry.headers.get("x-request-id")).toBe("retry");
  expect(retry.headers.get("access-control-allow-origin")).toBe("*");
  expect(retry.headers.get("cache-control")).toBe("no-store");
  expect(events).toEqual(["verify", "upstream", "settle"]);
});

test.each(["HEAD", "204", "205"])(
  "cached %s responses retain their null body",
  async (kind) => {
    const { app, events } = harness({
      upstream: async () =>
        new Response(null, { status: kind === "HEAD" ? 200 : Number(kind) }),
    });
    const headers = {
      "idempotency-key": "empty-response",
      "payment-signature": await signature(app),
    };
    const method = kind === "HEAD" ? "HEAD" : "GET";
    const first = await app.request("/v1/echo", { method, headers });
    const retry = await app.request("/v1/echo", { method, headers });
    expect(retry.status).toBe(first.status);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.text()).toBe("");
    expect(events).toEqual(["verify", "upstream", "settle"]);
  },
);

test.each(["invalid", "upstream", "settlement"])(
  "%s failure is not cached as a paid success",
  async (kind) => {
    const cache = new IdempotencyCache();
    const { app, events } = harness({
      idempotencyCache: cache,
      valid: kind !== "invalid",
      settles: kind !== "settlement",
      upstream: async () =>
        new Response("private-data", {
          status: kind === "upstream" ? 500 : 200,
        }),
    });
    const headers = {
      "idempotency-key": "failed-request",
      "payment-signature": await signature(app),
    };
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/v1/echo", { headers });
      expect(response.status).toBe(kind === "upstream" ? 500 : 402);
      expect(response.headers.get("idempotent-replayed")).toBeNull();
      expect(cache.size()).toBe(0);
      if (kind === "settlement")
        expect(await response.text()).not.toContain("private-data");
    }
    const flow =
      kind === "invalid"
        ? ["verify"]
        : kind === "upstream"
          ? ["verify", "upstream"]
          : ["verify", "upstream", "settle"];
    expect(events).toEqual([...flow, ...flow]);
  },
);

test("a shared cache isolates different upstream configurations", async () => {
  const cache = new IdempotencyCache();
  const first = harness({
    idempotencyCache: cache,
    upstream: async () => new Response("first-service"),
  });
  const second = harness({
    idempotencyCache: cache,
    env: { UPSTREAM_URL: "https://other.example" },
    upstream: async () => new Response("second-service"),
  });
  const headers = {
    "idempotency-key": "shared-key",
    "payment-signature": await signature(first.app),
  };
  expect(await (await first.app.request("/v1/echo", { headers })).text()).toBe(
    "first-service",
  );
  const response = await second.app.request("/v1/echo", { headers });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("second-service");
  expect(second.events).toEqual(["verify", "upstream", "settle"]);
});

test("fingerprinting preserves POST body bytes for upstream and retries", async () => {
  const body = new Uint8Array([0, 255, 128, 13, 10]);
  const { app, events } = harness({
    upstream: async (request) => {
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(body);
      return new Response("binary-accepted");
    },
  });
  const headers = {
    "idempotency-key": "binary",
    "payment-signature": await signature(app),
    "content-type": "application/octet-stream",
  };
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/v1/echo", {
      method: "POST",
      headers,
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("binary-accepted");
  }
  expect(events).toEqual(["verify", "upstream", "settle"]);
});

test("an oversized fingerprint body never verifies, calls upstream or reserves a key", async () => {
  const cache = new IdempotencyCache();
  const { app, events } = harness({
    idempotencyCache: cache,
    env: { MAX_BODY_BYTES: "4" },
  });
  const response = await app.request("/v1/echo", {
    method: "POST",
    body: "12345",
    headers: {
      "idempotency-key": "large",
      "payment-signature": await signature(app),
    },
  });
  expect(response.status).toBe(413);
  expect(events).toEqual([]);
  expect(cache.size()).toBe(0);
});

test.each(["abort", "timeout"])(
  "a fingerprint upload %s releases capacity without verifying payment",
  async (kind) => {
    const cache = new IdempotencyCache();
    const { app, events } = harness({
      idempotencyCache: cache,
      env: { UPSTREAM_TIMEOUT_MS: "30" },
    });
    const controller = new AbortController();
    const headers = {
      "idempotency-key": "interrupted",
      "payment-signature": await signature(app),
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
    });
    const timer =
      kind === "abort" ? setTimeout(() => controller.abort(), 5) : undefined;
    try {
      const response = await app.request("/v1/echo", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({
        error: "request_timeout_or_abort",
      });
      expect(events).toEqual([]);
      expect(cache.size()).toBe(0);
      const stats = await (await app.request("/stats")).json();
      expect(stats.capacity.active).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  },
);

test("a failed upstream releases both idempotency and nonce reservations", async () => {
  let fail = true;
  const cache = new IdempotencyCache();
  const { app, events } = harness({
    idempotencyCache: cache,
    nonceGuard: new PaymentNonceReplayGuard(),
    upstream: async () => new Response("result", { status: fail ? 500 : 200 }),
  });
  const headers = {
    "idempotency-key": "recoverable",
    "payment-signature": await signature(app),
  };
  expect((await app.request("/v1/echo", { headers })).status).toBe(500);
  expect(cache.size()).toBe(0);
  fail = false;
  expect((await app.request("/v1/echo", { headers })).status).toBe(200);
  const retry = await app.request("/v1/echo", { headers });
  expect(retry.status).toBe(200);
  expect(retry.headers.get("idempotent-replayed")).toBe("true");
  expect(events).toEqual([
    "verify",
    "upstream",
    "verify",
    "upstream",
    "settle",
  ]);
});

test("a refused settlement cannot be replayed through the success cache", async () => {
  const cache = new IdempotencyCache();
  const { app, events } = harness({
    idempotencyCache: cache,
    nonceGuard: new PaymentNonceReplayGuard(),
    settles: false,
  });
  const headers = {
    "idempotency-key": "refused",
    "payment-signature": await signature(app),
  };
  expect((await app.request("/v1/echo", { headers })).status).toBe(402);
  const retry = await app.request("/v1/echo", { headers });
  expect(retry.status).toBe(402);
  expect(retry.headers.get("idempotent-replayed")).toBeNull();
  expect(await retry.text()).not.toContain("protected response");
  expect(cache.size()).toBe(0);
  expect(events).toEqual(["verify", "upstream", "settle"]);
});
