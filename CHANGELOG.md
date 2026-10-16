# Changelog

## Unreleased

- Add standard Kubernetes `GET /livez` liveness probe endpoint returning `200 {"ok":true,"status":"alive"}` with `Cache-Control: no-store` independent of external network or facilitator status.
- Add `X-Response-Time` performance timing header across all responses measuring wrapper execution latency.
- Expose `X-Response-Time` in CORS headers (`Access-Control-Expose-Headers`) for web dApps and browser clients.
- Add unit tests verifying `/livez`, timing header formatting, and CORS exposure.

## 0.3.2

- Forward conditional 304 responses through settlement while refusing other 3xx statuses.
- Add facilitator readiness, response request IDs and early declared-body size checks.
- Validate readiness protocol/version and CORS configuration; preserve paid OPTIONS handling.
- Add configurable CORS support via `CORS_ORIGIN` (`*` or specific HTTP(S) origin) to allow browser dApps, Web3 extensions, and Kite AI web agents to interact with paid endpoints.
- Allow preflight `OPTIONS` requests to receive `204 No Content` with appropriate `Access-Control-Allow-*` headers without requiring payments.
- Expose essential x402 payment headers (`Payment-Required`, `Payment-Response`, `Retry-After`) to cross-origin browser clients.
- Add comprehensive CORS integration tests covering preflight, 402 challenges, paid responses, origin filtering, and configuration validation.
- Update English and Chinese documentation and `.env.example`.

## 0.3.1

- Make rejected-body and redirect stream cleanup non-blocking so stalled producer
  cancellation cannot retain a request slot. Preserve original errors when cleanup fails.
- Cancel unfinished reads, including already-aborted requests, and release reader locks.
- Add nine regression tests for stalled/rejected cleanup, capacity recovery, aborts
  and byte-preserving successful reads.

## 0.3.0

- Add `FACILITATOR_TIMEOUT_MS` (default 90000, range 1–300000) and validate
  environment and programmatic configuration while preserving older Config objects.
- Apply the official SDK HTTP abort mechanism to facilitator capability discovery,
  payment verification and settlement, including response headers and bodies.
- Add seven real HTTP timeout tests covering failure responses, concurrency-slot
  recovery, health availability and absence of automatic payment retries.
- Update English/Chinese documentation, CLI help and the environment example.

The timeout applies per HTTP attempt; SDK initialization backoff may extend the
whole request. Custom facilitator clients manage their own deadlines. Settlement
timeout leaves the payment outcome unknown and does not guarantee no charge.

## 0.2.0

- Bound the complete payment lifecycle with `MAX_CONCURRENT_REQUESTS` (default
  64). Excess requests receive a non-cacheable 503 `service_busy` and Retry-After
  before payment verification. Slots remain held until settlement completes.
- Release slots on success and failure; keep health checks independent.
- Add deterministic concurrency, settlement, initialization and recovery tests.
- Include Chinese documentation and updated configuration/CLI guidance.
- Make the CI package installation check follow the package version automatically.

This release adds a default concurrency cap. Operators needing a different limit
can set a value from 1 to 10000. The limit is per app instance, not distributed;
it does not implement payment deduplication or automatic payment retries.

## 0.1.0

- Initial Kite mainnet/testnet Bun/Hono x402 proxy, payment lifecycle tests,
  bounded bodies, credential filtering and installable npm package.
