import { expect, test } from "bun:test";
import { harness } from "./helpers.js";

test("maintenance mode keeps healthz 200 alive", async () => {
  const { app } = harness({
    env: { MAINTENANCE_MODE: "true" },
  });
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test("maintenance mode causes readyz to return 503 with maintenance_mode", async () => {
  const { app } = harness({
    env: { MAINTENANCE_MODE: "true" },
  });
  const res = await app.request("/readyz");
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { ok: boolean; error: string };
  expect(body).toEqual({ ok: false, error: "maintenance_mode" });
});

test("maintenance mode drains /v1/* endpoints with 503 and Retry-After", async () => {
  const { app, events } = harness({
    env: { MAINTENANCE_MODE: "true" },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("60");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { error: string; message: string };
  expect(body.error).toBe("maintenance_mode");
  expect(body.message).toBe("Service is currently undergoing maintenance");
  // Ensure no payment verification or upstream proxy was touched
  expect(events).toEqual([]);
});

test("service operates normally when MAINTENANCE_MODE is not set", async () => {
  const { app } = harness();
  const readyRes = await app.request("/readyz");
  expect(readyRes.status).toBe(200);

  const v1Res = await app.request("/v1/echo");
  // Default without payment signature returns 402 challenge
  expect(v1Res.status).toBe(402);
});
