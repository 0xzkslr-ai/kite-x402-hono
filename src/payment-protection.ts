import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { FacilitatorClient } from "@x402/core/server";
import type { Config } from "./config.js";
import type { AppOptions } from "./app.js";
import { IdempotencyCache } from "./idempotency.js";
import { readLimited } from "./proxy.js";

interface Lease {
  payer: string;
  nonce: string;
  settling: boolean;
}
interface Scope {
  lease?: Lease;
}

export function createPaymentProtection(
  base: FacilitatorClient,
  config: Config,
  options: AppOptions,
) {
  const storage = new AsyncLocalStorage<Scope>();
  const cache = options.idempotencyCache ?? new IdempotencyCache();
  const guard = options.nonceGuard;
  const facilitator: FacilitatorClient = {
    getSupported: () => base.getSupported(),
    verify: async (payload, requirements) => {
      const result = await base.verify(payload, requirements);
      const scope = storage.getStore();
      if (result.isValid && guard && scope) {
        const authorization = payload.payload.authorization as
          | { from?: string; nonce?: string }
          | undefined;
        const payer = result.payer ?? authorization?.from;
        const nonce = authorization?.nonce;
        if (!payer || !nonce || !guard.acquire(payer, nonce)) {
          return {
            isValid: false,
            invalidReason: "payment_nonce_replay_detected",
          };
        }
        scope.lease = { payer, nonce, settling: false };
      }
      return result;
    },
    settle: async (payload, requirements) => {
      const lease = storage.getStore()?.lease;
      // Reserve conservatively before settlement: a transport failure may hide a successful charge.
      if (lease && guard) {
        lease.settling = true;
        guard.commit(lease.payer, lease.nonce);
      }
      return base.settle(payload, requirements);
    },
  };

  async function run(c: Context, next: () => Promise<Response | void>) {
    const rawKey = c.req.header("idempotency-key");
    if (rawKey && !cache.validateKey(rawKey))
      return c.json({ error: "invalid_idempotency_key" }, 400);
    const signature =
      c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (guard && signature) {
      try {
        const parsed = JSON.parse(
          Buffer.from(signature, "base64").toString(),
        ) as any;
        const auth = parsed?.payload?.authorization;
        if (
          auth?.from &&
          auth?.nonce &&
          guard.check(auth.from, auth.nonce) === "CONSUMED"
        ) {
          return c.json(
            {
              error: "payment_nonce_replay_detected",
              message: "Payment nonce already consumed or currently in-flight",
            },
            402,
          );
        }
      } catch {
        // The x402 middleware will produce the canonical invalid-payment response.
      }
    }
    let key: string | undefined;
    if (rawKey) {
      let body = new Uint8Array();
      if (signature) {
        try {
          body = await readLimited(
            c.req.raw.clone().body,
            config.maxBodyBytes,
            AbortSignal.timeout(config.timeoutMs),
          );
        } catch {
          return c.json({ error: "idempotency_request_body_unavailable" }, 413);
        }
      }
      // Bind every request header, target and body to the payment credential; never index by user key alone.
      const headers = [...c.req.raw.headers].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      key = rawKey;
      const state = cache.acquire(key);
      if (state.status === "in_flight")
        return c.json({ error: "idempotency_conflict" }, 409);
      if (state.status === "cached") {
        const headers = new Headers(state.response.headers);
        headers.set("idempotent-replayed", "true");
        headers.set("cache-control", "no-store");
        return new Response(state.response.body as BodyInit, {
          status: state.response.statusCode,
          headers,
        });
      }
    }
    const scope: Scope = {};
    try {
      const result = await storage.run(scope, next);
      const response = result instanceof Response ? result : c.res;
      if (
        key &&
        response.status >= 200 &&
        response.status < 300 &&
        response.headers.has("payment-response")
      ) {
        const body = new Uint8Array(await response.clone().arrayBuffer());
        cache.complete(key, response.status, response.headers, body);
      } else if (key) cache.release(key);
      return result;
    } catch (error) {
      if (key) cache.release(key);
      throw error;
    } finally {
      if (scope.lease && !scope.lease.settling)
        guard?.release(scope.lease.payer, scope.lease.nonce);
    }
  }
  return { facilitator, run };
}
