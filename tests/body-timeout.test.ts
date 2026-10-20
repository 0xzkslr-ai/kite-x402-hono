import { expect, test } from "bun:test";
import { harness, signature } from "./helpers.js";

test("client aborting during body upload triggers 408 and abort cleanup immediately", async () => {
  const { app, events } = harness({ env: { UPSTREAM_TIMEOUT_MS: "100" } });
  const controller = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => controller.abort(), 10);
    },
  });

  const response = await app.request("/v1/echo", {
    method: "POST",
    body: stream,
    headers: { "payment-signature": await signature(app) },
    signal: controller.signal,
  });

  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({ error: "request_timeout_or_abort" });
  expect(events).toEqual(["verify"]);
});

test("stalled upload body respects short timeout and returns 408 without proxying upstream", async () => {
  const { app, events } = harness({ env: { UPSTREAM_TIMEOUT_MS: "20" } });

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([42]));
      // never close or enqueue further chunks
    },
  });

  const start = Date.now();
  const response = await app.request("/v1/echo", {
    method: "POST",
    body: stream,
    headers: { "payment-signature": await signature(app) },
  });
  const elapsed = Date.now() - start;

  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({ error: "request_timeout_or_abort" });
  expect(elapsed).toBeLessThan(1000); // must complete in tens of ms, never 5000ms
  expect(events).toEqual(["verify"]);
});
