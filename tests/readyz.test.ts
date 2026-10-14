import { expect, test } from "bun:test";
import type { SupportedResponse } from "@x402/core/types";
import { harness } from "./helpers.js";

test("readyz reports 200 when the facilitator offers the configured network", async () => {
  const { app, events } = harness();
  const response = await app.request("/readyz");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ok: boolean;
    network: string;
    asset: string;
    price: string;
  };
  expect(body.ok).toBe(true);
  expect(body.network).toBe("eip155:2368");
  expect(body.asset).toBe("pieUSD");
  expect(body.price).toBe("$0.001");
  expect(response.headers.get("payment-required")).toBeNull();
  // Readiness is free and must never touch verify or settle.
  expect(events).toEqual([]);
});

test("readyz reports 503 when the facilitator cannot be reached", async () => {
  const { app, events } = harness({
    facilitator: {
      getSupported: async () => {
        throw new Error("connection refused");
      },
    },
  });
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  const body = (await response.json()) as { ok: boolean; error: string };
  expect(body).toEqual({ ok: false, error: "facilitator_unavailable" });
  expect(events).toEqual([]);
});

test("readyz reports 503 when the configured network is not offered", async () => {
  const elsewhere = {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:9999",
      },
    ],
    extensions: [],
    signers: {},
  } as unknown as SupportedResponse;
  const { app } = harness({
    facilitator: { getSupported: async () => elsewhere },
  });
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  const body = (await response.json()) as {
    ok: boolean;
    error: string;
    network: string;
  };
  expect(body).toEqual({
    ok: false,
    error: "network_not_offered",
    network: "eip155:2368",
  });
});

test("readyz responds 503 with no-store so probes never cache a stale verdict", async () => {
  const { app } = harness({
    facilitator: {
      getSupported: async () => {
        throw new Error("connection refused");
      },
    },
  });
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
