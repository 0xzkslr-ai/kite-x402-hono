import { expect, test } from "bun:test";
import { createApp } from "../src/index.js";
import { harness, signature, testConfig } from "./helpers.js";

for (const kind of [
  { network: "eip155:2368", scheme: "upto", x402Version: 2 },
  { network: "eip155:2368", scheme: "exact", x402Version: 1 },
] as const) {
  test(`readiness rejects incompatible ${kind.scheme}/v${kind.x402Version}`, async () => {
    const { app, events } = harness({
      facilitator: {
        getSupported: async () => ({
          kinds: [kind],
          extensions: [],
          signers: {},
        }),
      },
    });
    const r = await app.request("/readyz");
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(events).toEqual([]);
  });
}

test("CORS only exempts genuine preflight and exposes request IDs", async () => {
  let supportedCalls = 0;
  const { app, events } = harness({
    env: { CORS_ORIGIN: "*" },
    facilitator: {
      getSupported: async () => {
        supportedCalls++;
        throw Error("offline");
      },
    },
  });
  const preflight = await app.request("/v1/echo", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "payment-signature,x-request-id",
    },
  });
  expect(preflight.status).toBe(204);
  expect(
    preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
  ).toContain("x-request-id");
  expect(preflight.headers.get("x-request-id")).toBeTruthy();
  expect(supportedCalls).toBe(0);
  expect(events).toEqual([]);
  const ordinary = await harness({ env: { CORS_ORIGIN: "*" } }).app.request(
    "/v1/echo",
    { method: "OPTIONS" },
  );
  expect(ordinary.status).toBe(402);
  const unavailable = await app.request("/v1/echo", {
    headers: { origin: "https://app.example" },
  });
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("access-control-allow-origin")).toBe("*");
  expect(
    unavailable.headers.get("access-control-expose-headers")?.toLowerCase(),
  ).toContain("x-request-id");
  expect(unavailable.headers.get("x-request-id")).toBeTruthy();
});

test("upstream cannot override wrapper origin policy", async () => {
  const { app } = harness({
    env: { CORS_ORIGIN: "https://allowed.example" },
    upstream: async () =>
      new Response("ok", {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
          "access-control-expose-headers": "x-secret",
          "x-request-id": "upstream-id",
        },
      }),
  });
  const sig = await signature(app);
  for (const origin of ["https://allowed.example", "https://denied.example"]) {
    const r = await app.request("/v1/echo", {
      headers: {
        origin,
        "payment-signature": sig,
        "x-request-id": "client-id",
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(
      origin === "https://allowed.example" ? origin : null,
    );
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(r.headers.get("access-control-expose-headers")).not.toContain(
      "x-secret",
    );
    expect(r.headers.get("x-request-id")).toBe("client-id");
  }
});

test("early size rejection carries CORS and request ID without contacting facilitator", async () => {
  let calls = 0;
  const { app, events } = harness({
    env: { CORS_ORIGIN: "*", MAX_BODY_BYTES: "4" },
    facilitator: {
      getSupported: async () => {
        calls++;
        throw Error("must not run");
      },
    },
  });
  const r = await app.request("/v1/echo", {
    method: "POST",
    body: "12345",
    headers: {
      "content-length": "5",
      origin: "https://app.example",
      "x-request-id": "size-test",
    },
  });
  expect(r.status).toBe(413);
  expect(r.headers.get("x-request-id")).toBe("size-test");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(calls).toBe(0);
  expect(events).toEqual([]);
});

test("programmatic CORS configuration is validated", () => {
  expect(() =>
    createApp({ ...testConfig(), corsOrigin: "https://example.com/path" }),
  ).toThrow();
});

test("request IDs cover 404 and internal errors", async () => {
  const { app } = harness();
  app.get("/test-error", () => {
    throw Error("private");
  });
  for (const [path, status] of [
    ["/missing", 404],
    ["/test-error", 500],
  ] as const) {
    const r = await app.request(path, {
      headers: { "x-request-id": "error-test" },
    });
    expect(r.status).toBe(status);
    expect(r.headers.get("x-request-id")).toBe("error-test");
  }
});

test("unsafe request IDs are stripped before upstream logging", async () => {
  const { app } = harness({
    upstream: async (r) => {
      expect(r.headers.get("x-request-id")).toBeNull();
      return new Response("ok");
    },
  });
  const r = await app.request("/v1/echo", {
    headers: {
      "x-request-id": "unsafe id",
      "payment-signature": await signature(app),
    },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

test("capacity rejection retains CORS and the caller request ID", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app } = harness({
    env: { MAX_CONCURRENT_REQUESTS: "1", CORS_ORIGIN: "*" },
    upstream: async () => {
      entered();
      await pending;
      return new Response("ok");
    },
  });
  const first = app.request("/v1/echo", {
    headers: { "payment-signature": await signature(app) },
  });
  try {
    await started;
    const r = await app.request("/v1/echo", {
      headers: { origin: "https://app.example", "x-request-id": "busy" },
    });
    expect(r.status).toBe(503);
    expect(r.headers.get("x-request-id")).toBe("busy");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("retry-after")).toBe("1");
  } finally {
    release();
    await first;
  }
});
