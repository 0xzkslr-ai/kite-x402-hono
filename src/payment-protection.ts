import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { FacilitatorClient } from "@x402/core/server";
import type { Config } from "./config.js";
import type { AppOptions } from "./app.js";
import { IdempotencyCache } from "./idempotency.js";
import { cleanHeaders, readLimited } from "./proxy.js";

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
  // Keep injected shared caches isolated across upstreams and payment configurations.
  const namespace = createHash("sha256")
    .update(
      JSON.stringify([
        config.upstream,
        config.chain.network,
        config.chain.asset,
        config.payTo,
        config.price,
        config.authHeader,
        config.authValue,
        config.facilitatorUrl,
      ]),
    )
    .digest("hex");
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
    let key: string | undefined;
    // A user-supplied key alone is never a credential for a paid response.
    if (rawKey && signature) {
      let body: Uint8Array;
      const controller = new AbortController();
      const onAbort = () => controller.abort(c.req.raw.signal.reason);
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      if (c.req.raw.signal.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        body = await readLimited(
          c.req.raw.clone().body,
          config.maxBodyBytes,
          controller.signal,
        );
      } catch {
        return controller.signal.aborted
          ? c.json({ error: "request_timeout_or_abort" }, 408)
          : c.json({ error: "idempotency_request_body_unavailable" }, 413);
      } finally {
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener("abort", onAbort);
      }
      const headers = cleanHeaders(c.req.raw.headers, config.authHeader);
      headers.delete("x-request-id");
      headers.set("accept-encoding", "identity");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            c.req.method,
            c.req.url,
            [...headers].sort(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .update(body)
        .digest("hex");
      key = createHash("sha256")
        .update(JSON.stringify([namespace, rawKey, signature]))
        .digest("hex");
      const state = cache.acquire(key, undefined, undefined, fingerprint);
      if (state.status === "in_flight" || state.status === "conflict")
        return c.json({ error: "idempotency_conflict" }, 409);
      if (state.status === "cached") {
        const headers = new Headers(state.response.headers);
        headers.set("idempotent-replayed", "true");
        headers.set("cache-control", "no-store");
        return new Response(
          c.req.method === "HEAD" ||
          [204, 205].includes(state.response.statusCode)
            ? null
            : (state.response.body as BodyInit),
          {
            status: state.response.statusCode,
            headers,
          },
        );
      }
    }
    const scope: Scope = {};
    try {
      // Exact, previously settled retries have already returned above. Cache
      // misses still obey nonce protection, including when the user key changes.
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
                message:
                  "Payment nonce already consumed or currently in-flight",
              },
              402,
            );
          }
        } catch {
          // The x402 middleware produces the canonical invalid-payment response.
        }
      }
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
      }
      return result;
    } finally {
      // Completed responses survive release; failed or rejected reservations do not.
      if (key) cache.release(key);
      if (scope.lease && !scope.lease.settling)
        guard?.release(scope.lease.payer, scope.lease.nonce);
    }
  }
  return { facilitator, run };
}
