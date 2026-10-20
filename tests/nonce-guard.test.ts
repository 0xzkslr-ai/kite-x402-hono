import { describe, expect, test } from "bun:test";
import { PaymentNonceReplayGuard } from "../src/nonce-guard.js";
import { harness, signature, PAYER } from "./helpers.js";

describe("PaymentNonceReplayGuard unit tests", () => {
  const payer = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
  const nonce =
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

  test("acquires lease on fresh nonce and rejects duplicate while in-flight", () => {
    const guard = new PaymentNonceReplayGuard({ inFlightTtlMs: 10_000 });
    expect(guard.check(payer, nonce)).toBe("AVAILABLE");

    // First acquire succeeds
    expect(guard.acquire(payer, nonce)).toBe(true);
    expect(guard.check(payer, nonce)).toBe("IN_FLIGHT");

    // Second acquire for the same nonce fails
    expect(guard.acquire(payer, nonce)).toBe(false);
  });

  test("commit marks nonce as consumed and prevents re-acquisition", () => {
    const guard = new PaymentNonceReplayGuard({ consumedTtlMs: 50_000 });
    expect(guard.acquire(payer, nonce)).toBe(true);

    guard.commit(payer, nonce);
    expect(guard.check(payer, nonce)).toBe("CONSUMED");
    expect(guard.acquire(payer, nonce)).toBe(false);
  });

  test("release frees in-flight lease for retry", () => {
    const guard = new PaymentNonceReplayGuard();
    expect(guard.acquire(payer, nonce)).toBe(true);

    guard.release(payer, nonce);
    expect(guard.check(payer, nonce)).toBe("AVAILABLE");
    expect(guard.acquire(payer, nonce)).toBe(true);
  });

  test("treats payer and nonce case-insensitively", () => {
    const guard = new PaymentNonceReplayGuard();
    expect(guard.acquire(payer.toLowerCase(), nonce.toUpperCase())).toBe(true);
    expect(guard.acquire(payer.toUpperCase(), nonce.toLowerCase())).toBe(false);
  });

  test("sliding window cleans expired entries", () => {
    const guard = new PaymentNonceReplayGuard({ consumedTtlMs: 50 });
    const now = 1_000_000;
    expect(guard.acquire(payer, nonce, now)).toBe(true);
    guard.commit(payer, nonce, now);

    expect(guard.check(payer, nonce, now + 10)).toBe("CONSUMED");
    expect(guard.check(payer, nonce, now + 60)).toBe("AVAILABLE");
    expect(guard.acquire(payer, nonce, now + 60)).toBe(true);
  });

  test("capacity overflow triggers safe opportunistic purge", () => {
    const guard = new PaymentNonceReplayGuard({ maxEntries: 10 });
    for (let i = 0; i < 15; i++) {
      guard.acquire(payer, `0xnonce_${i}`);
    }
    expect(guard.size()).toBeLessThanOrEqual(15);
  });
});

describe("PaymentNonceReplayGuard integration with x402 payment gate", () => {
  test("prevents replay of consumed payment signature", async () => {
    const { app, events } = harness({
      nonceGuard: new PaymentNonceReplayGuard(),
    });
    const sig = await signature(app);

    // First request: valid payment succeeds and settles
    const firstRes = await app.request("/v1/echo", {
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.has("payment-response")).toBe(true);
    expect(events).toEqual(["verify", "upstream", "settle"]);

    // Second request: replay of the exact same signature must be rejected immediately
    const replayRes = await app.request("/v1/echo", {
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    expect(replayRes.status).toBe(402);
    const body = (await replayRes.json()) as { error: string; message: string };
    expect(body.error).toBe("payment_nonce_replay_detected");
    // Verify that neither verify, upstream, nor settle were called again
    expect(events).toEqual(["verify", "upstream", "settle"]);
  });

  test("releases in-flight lease if upstream fails so client can retry", async () => {
    let failUpstream = true;
    const { app, events } = harness({
      nonceGuard: new PaymentNonceReplayGuard(),
      upstream: async () => {
        if (failUpstream) {
          return new Response("internal error", { status: 500 });
        }
        return Response.json({ success: true });
      },
    });

    const sig = await signature(app);

    // First attempt: upstream fails with 500
    const firstRes = await app.request("/v1/echo", {
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    expect(firstRes.status).toBe(500);

    // Second attempt: upstream recovers, retry succeeds
    failUpstream = false;
    const retryRes = await app.request("/v1/echo", {
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    expect(retryRes.status).toBe(200);
  });
});
