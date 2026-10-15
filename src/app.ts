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
import { loadConfig, type Config } from "./config.js";
import { parsePrice } from "./networks.js";
import { proxy, type FetchUpstream } from "./proxy.js";

export interface AppOptions {
  facilitator?: FacilitatorClient;
  fetchUpstream?: FetchUpstream;
}

export function createApp(
  config: Config = loadConfig(),
  options: AppOptions = {},
): Hono {
  const app = new Hono();
  if (config.corsOrigin) {
    app.use(
      "*",
      cors({
        origin: config.corsOrigin,
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
        ],
        exposeHeaders: [
          "Payment-Required",
          "Payment-Response",
          "X-Payment-Required",
          "X-Payment-Response",
          "Retry-After",
        ],
        maxAge: 86400,
      }),
    );
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
