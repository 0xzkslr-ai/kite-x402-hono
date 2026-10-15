#!/usr/bin/env bun
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: kite-x402-hono\nRequired: PAY_TO, UPSTREAM_URL\nOptional: KITE_NETWORK, PRICE_USD, PORT, FACILITATOR_URL, UPSTREAM_AUTH_HEADER, UPSTREAM_AUTH_VALUE, UPSTREAM_TIMEOUT_MS, MAX_BODY_BYTES, MAX_CONCURRENT_REQUESTS, FACILITATOR_TIMEOUT_MS, CORS_ORIGIN\nSee README.md for configuration and examples.",
  );
} else {
  try {
    const config = loadConfig();
    const app = createApp(config);
    const server = Bun.serve({
      port: config.port,
      fetch: app.fetch,
      maxRequestBodySize: config.maxBodyBytes,
      idleTimeout: 0,
    });
    console.log(
      `Kite x402 Hono listening at ${server.url} (${config.chain.network})`,
    );
    const shutdown = () => {
      void server.stop(true);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unable to start wrapper",
    );
    process.exitCode = 1;
  }
}
