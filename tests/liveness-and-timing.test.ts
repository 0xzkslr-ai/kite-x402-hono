import { expect, test } from "bun:test";
import { harness } from "./helpers.js";

const TIMING_PATTERN = /^\d+\.\d{2}ms$/;

test("livez returns 200 with alive status and no-store caching", async () => {
  const { app, events } = harness();
  const response = await app.request("/livez");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; status: string };
  expect(body).toEqual({ ok: true, status: "alive" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  // Liveness must never interact with facilitator
  expect(events).toEqual([]);
});

test("responses carry x-response-time header matching ms pattern", async () => {
  const { app } = harness();
  const resLivez = await app.request("/livez");
  const timeLivez = resLivez.headers.get("x-response-time");
  expect(timeLivez).not.toBeNull();
  expect(timeLivez!).toMatch(TIMING_PATTERN);

  const resHealth = await app.request("/healthz");
  const timeHealth = resHealth.headers.get("x-response-time");
  expect(timeHealth).not.toBeNull();
  expect(timeHealth!).toMatch(TIMING_PATTERN);

  const resChallenge = await app.request("/v1/protected");
  expect(resChallenge.status).toBe(402);
  const timeChallenge = resChallenge.headers.get("x-response-time");
  expect(timeChallenge).not.toBeNull();
  expect(timeChallenge!).toMatch(TIMING_PATTERN);
});

test("CORS exposes x-response-time to browser dApps", async () => {
  const { app } = harness({
    env: { CORS_ORIGIN: "https://agent.kite.ai" },
  });
  const response = await app.request("/v1/protected", {
    method: "GET",
    headers: {
      Origin: "https://agent.kite.ai",
    },
  });
  expect(response.status).toBe(402);
  const exposed = (
    response.headers.get("access-control-expose-headers") ?? ""
  ).toLowerCase();
  expect(exposed).toContain("x-response-time");
  expect(exposed).toContain("x-request-id");
});
