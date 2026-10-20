import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import {
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { loadConfig, parseCorsOrigin, type Config } from "./config.js";
import { parsePrice } from "./networks.js";
import { proxy, REQUEST_ID_PATTERN, type FetchUpstream } from "./proxy.js";
import {
  createRateLimiterMiddleware,
  type RateLimiterOptions,
} from "./rate-limiter.js";

export interface AppOptions {
  facilitator?: FacilitatorClient;
  fetchUpstream?: FetchUpstream;
  rateLimiter?: RateLimiterOptions;
}

export function createApp(
  config: Config = loadConfig(),
  options: AppOptions = {},
): Hono {
  const app = new Hono();
  // Label every response — paid answers, 402 challenges, guard-rail rejections
  // and errors alike — with a request ID the caller can quote back in issues
  // and correlate across agent, wrapper and upstream logs. A caller-supplied
  // value is echoed only when it fits a conservative token alphabet, so the
  // header cannot smuggle control characters or flood logs; anything else
  // gets a freshly minted UUID. Caller-supplied IDs also travel upstream,
  // because x-request-id is not on the proxy's blocked list.
  app.use("*", async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId =
      inbound && REQUEST_ID_PATTERN.test(inbound)
        ? inbound
        : crypto.randomUUID();
    await next();
    c.res.headers.set("x-request-id", requestId);
  });
  if (config.corsOrigin) {
    const corsMiddleware = cors({
      origin: parseCorsOrigin(config.corsOrigin),
      allowMethods: [
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "OPTIONS",
      ],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Payment-Signature",
        "X-Payment",
        "X-Requested-With",
        "X-Request-ID",
      ],
      exposeHeaders: [
        "Payment-Required",
        "Payment-Response",
        "X-Payment-Required",
        "X-Payment-Response",
        "Retry-After",
        "X-Request-ID",
      ],
      maxAge: 86400,
    });
    app.use("*", (c, next) => {
      // Only browser preflight bypasses the paid OPTIONS route.
      if (
        c.req.method === "OPTIONS" &&
        !(
          c.req.header("origin") &&
          c.req.header("access-control-request-method")
        )
      ) {
        return next();
      }
      return corsMiddleware(c, next);
    });
  }
  if (options.rateLimiter) {
    app.use("*", createRateLimiterMiddleware(options.rateLimiter));
  }
  const facilitatorTimeoutMs = config.facilitatorTimeoutMs ?? 90000;
  if (
    !Number.isInteger(facilitatorTimeoutMs) ||
    facilitatorTimeoutMs < 1 ||
    facilitatorTimeoutMs > 300000
  ) {
    throw new Error(
      "facilitatorTimeoutMs must be an integer between 1 and 300000",
    );
  }
  const capacity = config.maxConcurrentRequests ?? 64;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) {
    throw new Error(
      "maxConcurrentRequests must be an integer between 1 and 10000",
    );
  }
  let active = 0;
  // Reject a body that is already known to exceed the configured limit before
  // contacting the facilitator. Chunked or incorrectly declared bodies remain
  // protected by proxy's bounded stream reader.
  app.use("/v1/*", async (c, next) => {
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const declaredLength = c.req.header("content-length");
      if (
        declaredLength &&
        /^\d+$/.test(declaredLength) &&
        BigInt(declaredLength) > BigInt(config.maxBodyBytes)
      ) {
        c.header("Cache-Control", "no-store");
        return c.json({ error: "request_too_large" }, 413);
      }
    }
    await next();
  });
  // Cover initialization, verification, upstream and settlement, not just proxy I/O.
  // Never queue payment-bearing requests or retain their signatures.
  app.use("/v1/*", async (c, next) => {
    if (active >= capacity) {
      c.header("Retry-After", "1");
      c.header("Cache-Control", "no-store");
      return c.json({ error: "service_busy" }, 503);
    }
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  const facilitator =
    options.facilitator ??
    new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      timeoutMs: facilitatorTimeoutMs,
    });
  const server = new x402ResourceServer(facilitator).register(
    config.chain.network,
    new ExactEvmScheme(),
  );
  const httpServer = new x402HTTPResourceServer(server, {
    "/v1/*": {
      accepts: {
        scheme: "exact",
        price: parsePrice(config.price, config.chain),
        network: config.chain.network,
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      },
      description: config.description,
      mimeType: "application/json",
    },
  });
  const payments = paymentMiddlewareFromHTTPServer(
    httpServer,
    undefined,
    undefined,
    false,
  );
  // Initialize lazily so /healthz never needs network access and startup errors stay request-scoped.
  let initialization: Promise<void> | undefined;
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      network: config.chain.network,
      asset: config.chain.symbol,
      price: `$${config.price}`,
    }),
  );
  // Readiness is stronger than liveness: the process is up and the facilitator
  // advertises the configured protocol and network; this does not prove settlement.
  app.get("/readyz", async (c) => {
    let supported;
    try {
      supported = await facilitator.getSupported();
    } catch {
      return c.json({ ok: false, error: "facilitator_unavailable" }, 503, {
        "cache-control": "no-store",
      });
    }
    const offered = supported.kinds.some(
      (kind) =>
        kind.network === config.chain.network &&
        kind.scheme === "exact" &&
        kind.x402Version === 2,
    );
    if (!offered) {
      return c.json(
        {
          ok: false,
          error: "network_not_offered",
          network: config.chain.network,
        },
        503,
        { "cache-control": "no-store" },
      );
    }
    return c.json(
      {
        ok: true,
        network: config.chain.network,
        asset: config.chain.symbol,
        price: `$${config.price}`,
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  app.use("/v1/*", async (c, next) => {
    c.header("cache-control", "no-store");
    try {
      initialization ??= httpServer.initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      await initialization;
    } catch {
      return c.json({ error: "facilitator_unavailable" }, 503);
    }
    return payments(c, next);
  });
  app.all("/v1/*", (c) =>
    proxy(
      c.req.raw,
      config,
      options.fetchUpstream ?? ((request) => fetch(request)),
    ),
  );
  app.onError(() =>
    Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "cache-control": "no-store" } },
    ),
  );
  return app;
}
