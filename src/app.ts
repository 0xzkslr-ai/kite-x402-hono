import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
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
  TokenBucketRateLimiter,
  createRateLimiterMiddleware,
  type RateLimiterOptions,
} from "./rate-limiter.js";
import { evaluateIpFilter, extractClientIp } from "./firewall.js";
import { IdempotencyCache } from "./idempotency.js";
import { PaymentNonceReplayGuard } from "./nonce-guard.js";
import { createPaymentProtection } from "./payment-protection.js";
import { createAccessLogger } from "./logger.js";

export interface AppOptions {
  facilitator?: FacilitatorClient;
  fetchUpstream?: FetchUpstream;
  rateLimiter?: RateLimiterOptions;
  idempotencyCache?: IdempotencyCache;
  nonceGuard?: PaymentNonceReplayGuard;
  clientIp?: (c: Context) => string | null;
  logSink?: ((line: string) => void) | undefined;
}

export function createApp(
  config: Config = loadConfig(),
  options: AppOptions = {},
): Hono {
  const app = new Hono();

  // Attach standard security headers to protect against MIME-sniffing,
  // clickjacking, and XSS across all routes.
  app.use("*", secureHeaders());
  const startTime = Date.now();
  let totalRequests = 0;
  let activeRequests = 0;
  const statusCounts: Record<string, number> = {};

  if (config.logEnabled !== false) {
    app.use(
      "*",
      createAccessLogger(
        {
          format: config.logFormat,
          enabled: config.logEnabled,
          skipHealthz: true,
        },
        options.logSink,
      ),
    );
  }
  // Label every response — paid answers, 402 challenges, guard-rail rejections
  // and errors alike — with a request ID the caller can quote back in issues
  // and correlate across agent, wrapper and upstream logs. A caller-supplied
  // value is echoed only when it fits a conservative token alphabet, so the
  // header cannot smuggle control characters or flood logs; anything else
  // gets a freshly minted UUID. Caller-supplied IDs also travel upstream,
  // because x-request-id is not on the proxy's blocked list.
  app.use("*", async (c, next) => {
    const start = performance.now();
    totalRequests++;
    activeRequests++;
    const inbound = c.req.header("x-request-id");
    const requestId =
      inbound && REQUEST_ID_PATTERN.test(inbound)
        ? inbound
        : crypto.randomUUID();
    try {
      await next();
    } finally {
      activeRequests--;
      const statusGroup = `${Math.floor(c.res.status / 100)}xx`;
      statusCounts[statusGroup] = (statusCounts[statusGroup] ?? 0) + 1;
      statusCounts[String(c.res.status)] =
        (statusCounts[String(c.res.status)] ?? 0) + 1;
    }
    const durationMs = performance.now() - start;
    c.res.headers.set("x-request-id", requestId);
    c.res.headers.set("x-response-time", `${durationMs.toFixed(2)}ms`);
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
        "Idempotency-Key",
      ],
      exposeHeaders: [
        "Payment-Required",
        "Payment-Response",
        "X-Payment-Required",
        "X-Payment-Response",
        "Retry-After",
        "X-Request-ID",
        "X-Response-Time",
        "Idempotent-Replayed",
      ],
      maxAge: 86400,
    });
    app.use("*", async (c, next) => {
      // Only browser preflight bypasses the paid OPTIONS route.
      if (c.req.method === "OPTIONS") {
        if (
          c.req.header("origin") &&
          c.req.header("access-control-request-method")
        ) {
          return corsMiddleware(c, next);
        }
        return next();
      }
      // Settlement errors can replace the response in the payment middleware.
      // Apply CORS to the final response so browsers can read those failures too.
      await next();
      return corsMiddleware(c, async () => {});
    });
  }
  const getClientIp =
    options.clientIp ??
    ((c: Context) =>
      config.trustProxyHeaders !== false
        ? extractClientIp(c.req.raw.headers)
        : (c.env?.clientIp ?? null));
  if (config.firewallAllowlist?.length || config.firewallBlocklist?.length) {
    app.use("/v1/*", async (c, next) => {
      const ip = getClientIp(c);
      const verdict = evaluateIpFilter(ip, {
        allowlist: config.firewallAllowlist,
        blocklist: config.firewallBlocklist,
      });
      if (!verdict.allowed)
        return c.json(
          {
            error: "forbidden_ip",
            reason: verdict.reason,
            ip: ip ?? "unknown",
          },
          403,
          { "cache-control": "no-store" },
        );
      return next();
    });
  }
  if (config.rateLimitRps) {
    const rateLimiter = new TokenBucketRateLimiter(
      config.rateLimitBurst === undefined
        ? { rps: config.rateLimitRps }
        : { rps: config.rateLimitRps, burst: config.rateLimitBurst },
    );
    app.use("/v1/*", async (c, next) => {
      const clientIp = getClientIp(c) ?? "global";

      const decision = rateLimiter.consume(clientIp);
      if (!decision.allowed) {
        c.header("Retry-After", String(decision.resetSeconds));
        c.header("X-RateLimit-Limit", String(decision.limit));
        c.header("X-RateLimit-Remaining", "0");
        c.header("X-RateLimit-Reset", String(decision.resetSeconds));
        c.header("Cache-Control", "no-store");
        return c.json({ error: "rate_limit_exceeded" }, 429);
      }

      await next();
      c.res.headers.set("X-RateLimit-Limit", String(decision.limit));
      c.res.headers.set("X-RateLimit-Remaining", String(decision.remaining));
      c.res.headers.set("X-RateLimit-Reset", String(decision.resetSeconds));
    });
  }
  if (options.rateLimiter) {
    app.use("/v1/*", createRateLimiterMiddleware(options.rateLimiter));
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
  const startedAt = Date.now();
  const metrics = {
    total: 0,
    successful: 0,
    challenges: 0,
    busy: 0,
    tooLarge: 0,
  };
  // Reject a body that is already known to exceed the configured limit before
  // contacting the facilitator. Chunked or incorrectly declared bodies remain
  // protected by proxy's bounded stream reader.
  app.use("/v1/*", async (c, next) => {
    metrics.total++;
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const declaredLength = c.req.header("content-length");
      if (
        declaredLength &&
        /^\d+$/.test(declaredLength) &&
        BigInt(declaredLength) > BigInt(config.maxBodyBytes)
      ) {
        metrics.tooLarge++;
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
      metrics.busy++;
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
  const protection = createPaymentProtection(facilitator, config, options);
  const server = new x402ResourceServer(protection.facilitator).register(
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
  // Standard Kubernetes liveness probe (independent of facilitator and network dependencies)
  app.get("/livez", (c) =>
    c.json(
      {
        ok: true,
        status: "alive",
      },
      200,
      { "cache-control": "no-store" },
    ),
  );
  // Public runtime diagnostics
  app.get("/metrics", (c) =>
    c.json(
      {
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        total_requests: totalRequests,
        active_requests: activeRequests,
        status_counts: statusCounts,
        network: config.chain.network,
        asset: config.chain.symbol,
        memory: {
          rss: process.memoryUsage().rss,
          heap_used: process.memoryUsage().heapUsed,
          heap_total: process.memoryUsage().heapTotal,
        },
      },
      200,
      { "cache-control": "no-store" },
    ),
  );

  // Machine-readable capability and pricing discovery for autonomous agents
  app.get("/.well-known/x402", (c) => {
    const priceInfo = parsePrice(config.price, config.chain);
    return c.json({
      x402Version: 2,
      scheme: "exact",
      network: config.chain.network,
      asset: {
        address: config.chain.asset,
        symbol: config.chain.symbol,
        decimals: config.chain.decimals,
        name: config.chain.name,
        version: config.chain.version,
      },
      pricing: {
        usd: `$${config.price}`,
        atomicAmount: priceInfo.amount,
        payTo: config.payTo,
      },
      facilitator: config.facilitatorUrl,
      description: config.description,
      limits: {
        maxBodyBytes: config.maxBodyBytes,
        upstreamTimeoutMs: config.timeoutMs,
        maxConcurrentRequests: config.maxConcurrentRequests ?? 64,
        facilitatorTimeoutMs: config.facilitatorTimeoutMs ?? 90000,
      },
    });
  });
  // Readiness is stronger than liveness: the process is up and the facilitator
  // advertises the configured protocol and network; this does not prove settlement.
  app.get("/readyz", async (c) => {
    if (config.maintenanceMode) {
      return c.json({ ok: false, error: "maintenance_mode" }, 503, {
        "cache-control": "no-store",
      });
    }
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
  // Stats returns operational metrics: uptime, capacity utilization, and request outcomes.
  app.get("/stats", (c) =>
    c.json(
      {
        ok: true,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        capacity: {
          limit: capacity,
          active,
        },
        traffic: {
          total: metrics.total,
          successful: metrics.successful,
          challenges: metrics.challenges,
          busy: metrics.busy,
          too_large: metrics.tooLarge,
        },
        network: {
          chain: config.chain.network,
          asset: config.chain.symbol,
          price: `$${config.price}`,
        },
      },
      200,
      { "cache-control": "no-store" },
    ),
  );
  app.use("/v1/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (config.maintenanceMode) {
      return c.json(
        {
          error: "maintenance_mode",
          message: "Service is currently undergoing maintenance",
        },
        503,
        {
          "retry-after": "60",
          "cache-control": "no-store",
        },
      );
    }
    try {
      initialization ??= httpServer.initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      await initialization;
    } catch {
      return c.json({ error: "facilitator_unavailable" }, 503);
    }
    const result = await protection.run(c, () => payments(c, next));
    const status =
      (result instanceof Response ? result.status : undefined) ?? c.res?.status;
    if (status === 402) {
      metrics.challenges++;
    }
    if (status >= 200 && status < 300) metrics.successful++;
    return result;
  });
  app.all("/v1/*", async (c) => {
    const response = await proxy(
      c.req.raw,
      config,
      options.fetchUpstream ?? ((request) => fetch(request)),
    );
    return response;
  });
  app.notFound((c) =>
    c.json({ error: "not_found" }, 404, { "cache-control": "no-store" }),
  );
  app.onError(() =>
    Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "cache-control": "no-store" } },
    ),
  );
  return app;
}
