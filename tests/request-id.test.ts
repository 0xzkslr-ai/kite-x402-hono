import { expect, test } from "bun:test";
import { harness, signature } from "./helpers.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("responses without a caller request id get a minted UUID", async () => {
  const { app } = harness();
  const response = await app.request("/healthz");
  expect(response.status).toBe(200);
  const id = response.headers.get("x-request-id");
  expect(id).toMatch(UUID_PATTERN);
});

test("a valid caller request id is echoed back", async () => {
  const { app } = harness();
  const response = await app.request("/healthz", {
    headers: { "x-request-id": "agent-run-42.7" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe("agent-run-42.7");
});

test.each([
  ["contains spaces", "run 42"],
  ["too long", "a".repeat(129)],
  ["carries url syntax", "https://evil.example/run"],
])("an unsafe request id (%s) is replaced, not echoed", async (_reason, id) => {
  const { app } = harness();
  const response = await app.request("/healthz", {
    headers: { "x-request-id": id },
  });
  expect(response.status).toBe(200);
  const echoed = response.headers.get("x-request-id");
  expect(echoed).toMatch(UUID_PATTERN);
  expect(echoed).not.toBe(id);
});

test("unpaid 402 challenges are labelled too", async () => {
  const { app } = harness();
  const response = await app.request("/v1/echo");
  expect(response.status).toBe(402);
  expect(response.headers.get("x-request-id")).toMatch(UUID_PATTERN);
});

test("paid responses are labelled and the caller id travels upstream", async () => {
  const { app, events } = harness({
    upstream: async (request) => {
      expect(request.headers.get("x-request-id")).toBe("agent-run-42.7");
      return Response.json({ ok: true });
    },
  });
  const response = await app.request("/v1/echo", {
    headers: {
      "x-request-id": "agent-run-42.7",
      "payment-signature": await signature(app),
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe("agent-run-42.7");
  expect(events).toEqual(["verify", "upstream", "settle"]);
});
