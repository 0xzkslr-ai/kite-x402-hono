import { expect, test } from "bun:test";
import { harness, signature } from "./helpers.js";

test("POST preserves query and bytes, strips payment/client secrets and injects upstream auth", async () => {
  const { app } = harness({
    env: {
      UPSTREAM_AUTH_HEADER: "X-Api-Key",
      UPSTREAM_AUTH_VALUE: "server-only-key",
    },
    upstream: async (request) => {
      expect(request.url).toBe("https://upstream.example/echo?x=1&x=2");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe('{"unicode":"Kite"}');
      expect(request.headers.get("x-api-key")).toBe("server-only-key");
      for (const header of [
        "payment-signature",
        "x-payment",
        "authorization",
        "cookie",
        "x-forwarded-host",
        "x-remove",
      ])
        expect(request.headers.get(header)).toBeNull();
      return Response.json(
        { ok: true },
        {
          headers: {
            "x-api-key": "server-only-key",
            "set-cookie": "private=1",
            "payment-response": "forged",
            "x402-settlement-overrides": "forged",
            connection: "x-internal",
            "x-internal": "private",
            "x-safe": "keep",
          },
        },
      );
    },
  });
  const response = await app.request("/v1/echo?x=1&x=2", {
    method: "POST",
    body: '{"unicode":"Kite"}',
    headers: {
      "content-type": "application/json",
      "payment-signature": await signature(app),
      "x-payment": "private",
      authorization: "buyer-secret",
      cookie: "private",
      "x-api-key": "buyer-override",
      "x-forwarded-host": "evil.example",
      connection: "x-remove",
      "x-remove": "hop-value",
    },
  });
  expect(response.status).toBe(200);
  for (const header of [
    "x-api-key",
    "set-cookie",
    "x-internal",
    "x402-settlement-overrides",
  ])
    expect(response.headers.get(header)).toBeNull();
  expect(response.headers.get("payment-response")).not.toBe("forged");
  expect(response.headers.get("x-safe")).toBe("keep");
});

test("a double slash cannot change upstream origin", async () => {
  const { app } = harness({
    upstream: async (request) => {
      expect(new URL(request.url).origin).toBe("https://upstream.example");
      return Response.json({ ok: true });
    },
  });
  const response = await app.request("/v1//evil.example/path", {
    headers: { "payment-signature": await signature(app) },
  });
  expect(response.status).toBe(200);
});

test.each([300, 301, 302, 303, 307, 308])(
  "upstream redirect %s is refused without settlement",
  async (status) => {
    const { app, events } = harness({
      upstream: async (request) => {
        expect(request.redirect).toBe("manual");
        return new Response(null, {
          status,
          headers: { location: "https://evil.example" },
        });
      },
    });
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(events).toEqual(["verify", "upstream"]);
  },
);

test("304 Not Modified is forwarded for conditional requests", async () => {
  const { app, events } = harness({
    upstream: async (request) => {
      expect(request.headers.get("if-none-match")).toBe('"abc123"');
      return new Response(null, {
        status: 304,
        headers: {
          etag: '"abc123"',
          "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
        },
      });
    },
  });
  const response = await app.request("/v1/echo", {
    headers: {
      "if-none-match": '"abc123"',
      "payment-signature": await signature(app),
    },
  });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe('"abc123"');
  expect(response.headers.get("last-modified")).toBe(
    "Wed, 21 Oct 2026 07:28:00 GMT",
  );
  // The upstream answered the client's question, so the charge settles.
  expect(events).toEqual(["verify", "upstream", "settle"]);
});

test("oversized request never reaches upstream", async () => {
  const { app, events } = harness({ env: { MAX_BODY_BYTES: "4" } });
  const response = await app.request("/v1/echo", {
    method: "POST",
    body: "12345",
    headers: { "payment-signature": await signature(app) },
  });
  expect(response.status).toBe(413);
  expect(events).toEqual(["verify"]);
});

test("oversized response does not settle", async () => {
  const { app, events } = harness({
    env: { MAX_BODY_BYTES: "4" },
    upstream: async () => new Response("12345"),
  });
  const response = await app.request("/v1/echo", {
    headers: { "payment-signature": await signature(app) },
  });
  expect(response.status).toBe(502);
  expect(events).toEqual(["verify", "upstream"]);
});

test("204 response can settle without a response body", async () => {
  const { app, events } = harness({
    upstream: async () => new Response(null, { status: 204 }),
  });
  const response = await app.request("/v1/echo", {
    headers: { "payment-signature": await signature(app) },
  });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(events).toEqual(["verify", "upstream", "settle"]);
});

test("stalled request body times out before calling upstream", async () => {
  const { app, events } = harness({ env: { UPSTREAM_TIMEOUT_MS: "10" } });
  const response = await app.request("/v1/echo", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }),
    headers: { "payment-signature": await signature(app) },
  });
  expect(response.status).toBe(408);
  expect(events).toEqual(["verify"]);
});
