# Kite x402 Hono

中文文档：[README.zh-CN.md](README.zh-CN.md)

[![CI](https://github.com/BrKDDD/kite-x402-hono/actions/workflows/ci.yml/badge.svg)](https://github.com/BrKDDD/kite-x402-hono/actions/workflows/ci.yml)

A Bun/Hono reverse-proxy template for paid HTTP APIs on Kite. It complements
the [official Express and Go templates](https://github.com/gokite-ai/kite-x402-services)
with the same environment variables and `/v1/*` contract, using the official
`@x402/hono` middleware rather than implementing payment verification itself.

Independent community project. Apache-2.0; upstream attribution is in NOTICE.

## Quick start from source

Requires Bun 1.3 or later and Node.js 22 or later for npm/build tooling.
CI is pinned to Bun 1.4.2.

```sh
git clone https://github.com/BrKDDD/kite-x402-hono.git
cd kite-x402-hono
npm ci
cp .env.example .env
# Replace PAY_TO in .env with your own receiving wallet.
bun run example
```

In another terminal in the same directory:

```sh
bun run start
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/readyz
curl -i 'http://localhost:8080/v1/echo?message=hello'
```

`/healthz` returns 200 without contacting a facilitator. `/readyz` actually
calls the facilitator's `/supported` endpoint and returns 200 only when the
configured Kite network is offered with x402 v2 and the exact scheme, so orchestrators can distinguish
"process up" from "supported payment protocol". This does not prove that
the upstream is ready or that a payment will settle. `/v1/echo` returns
402 with an x402 v2 `PAYMENT-REQUIRED` header when the configured facilitator
is reachable and supports the selected network. A facilitator outage returns
503 instead; the upstream is never called without verified payment.

The example is a local echo API, not a deployed service or paid-call receipt.
Bun reads `.env` automatically; the library's `loadConfig()` only reads the
environment supplied to it.

## Package use

Install from [npm](https://www.npmjs.com/package/kite-x402-hono):

```sh
npm install kite-x402-hono
bunx kite-x402-hono --help
# Set PAY_TO and UPSTREAM_URL, or provide a local .env, before starting.
bunx kite-x402-hono
```

Library API:

```ts
import { createApp, loadConfig } from "kite-x402-hono";

const config = loadConfig();
const app = createApp(config);
Bun.serve({ port: config.port, fetch: app.fetch });
```

`createApp(config, { facilitator, fetchUpstream })` also allows dependency
injection for tests. Never use a simulated facilitator in a production service.

## Configuration

| Variable                  | Default                              | Meaning                                                                         |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `PAY_TO`                  | Required                             | Nonzero EVM receiving address                                                   |
| `UPSTREAM_URL`            | Required                             | Fixed HTTP(S) origin, with no path, credentials or query                        |
| `KITE_NETWORK`            | `mainnet`                            | `mainnet` or `testnet`                                                          |
| `PRICE_USD`               | `0.001`                              | Positive decimal, at most 6 fractional digits; optional `$` prefix              |
| `FACILITATOR_URL`         | `https://facilitator.pieverse.io/v2` | Keep the `/v2` suffix                                                           |
| `UPSTREAM_AUTH_HEADER`    | `Authorization`                      | Upstream credential header name                                                 |
| `UPSTREAM_AUTH_VALUE`     | Empty                                | Server-side credential; replaces buyer-supplied values                          |
| `SERVICE_DESCRIPTION`     | Kite paid API description            | Included in the payment challenge                                               |
| `PORT`                    | `8080`                               | Wrapper port                                                                    |
| `UPSTREAM_TIMEOUT_MS`     | `10000`                              | Timeout for reading the request body, then separately for upstream headers/body |
| `MAX_BODY_BYTES`          | `1048576`                            | Request and response byte limit; maximum 16 MiB                                 |
| `MAX_CONCURRENT_REQUESTS` | `64`                                 | Concurrency admission limit for `/v1/*` requests (1 to 10000)                   |
| `FACILITATOR_TIMEOUT_MS`  | `90000`                              | Timeout in ms for facilitator network requests (1 to 300000)                    |
| `CORS_ORIGIN`             | Unset                                | Allowed origin for CORS (`*` or HTTP(S) origin); enables browser dApp clients   |
| `SHUTDOWN_TIMEOUT_MS`     | `10000`                              | Timeout in ms to drain active in-flight requests on SIGINT/SIGTERM (1 to 60000) |

HTTPS is required for upstream/facilitator URLs except localhost development.
The example `.env` explicitly selects testnet; the compatibility default remains
mainnet. This wrapper requires no wallet private key.

| Network | CAIP-2        | Token  | Decimals | EIP-712 domain                        |
| ------- | ------------- | ------ | -------- | ------------------------------------- |
| Mainnet | `eip155:2366` | USDC.e | 6        | `Bridged USDC (Kite AI)`, version `2` |
| Testnet | `eip155:2368` | pieUSD | 18       | `pieUSD`, version `1`                 |

Token addresses are pinned in `src/networks.ts` from official Kite template
revision `893a27509648b660bbba626b0da59619a94f04ab`. Price conversion uses
integer arithmetic, including for testnet's 18 decimals.

## Payment and proxy contract

1. No payment or invalid payment: return 402; do not call the upstream.
2. Verified payment: strip `/v1`, preserve the query/method/body, inject the
   configured upstream credential, and call the fixed upstream origin.
3. Upstream 2xx or conditional 304: buffer the bounded response, then ask the facilitator to settle.
4. Successful settlement: return the upstream response and `PAYMENT-RESPONSE`.
5. Upstream 4xx/5xx, timeout, oversized body or connection failure: do not settle.
6. Settlement refusal: return the SDK failure response, withholding protected data.

Compatibility notes:

- `/v1/echo` maps to upstream `/echo`. `/v1/v1/forecast` maps to `/v1/forecast`.
- All HTTP methods under `/v1/*` are paid; the selected upstream must support them.
- Unlike the reference template's general below-400 rule, this template **refuses
  upstream redirects** with 502, without settlement, so credentials cannot follow
  redirects to a different host. Use the final upstream origin directly.
  Conditional `304 Not Modified` answers are not redirects and are forwarded, so
  client-side `If-None-Match` / `If-Modified-Since` still works.
- Payment headers, client authorization/cookies, proxy headers and hop-by-hop
  headers are removed. Upstream authentication response headers and cookies are
  also stripped. The upstream is trusted: do not select one that echoes secrets
  into response bodies or unrelated headers.
- Response buffering is deliberate. Streaming/SSE, WebSocket and unbounded
  downloads are outside this template's scope.
- Requests whose valid `Content-Length` already exceeds `MAX_BODY_BYTES` are
  rejected before facilitator verification. Streaming, chunked and incorrectly
  declared bodies are still enforced while the proxy reads them.
- Upstream actions happen before settlement. For non-idempotent POST operations,
  settlement failure does not undo the upstream action. Use an upstream with
  idempotency support; the wrapper does not provide exactly-once execution.
- A facilitator timeout may leave the on-chain settlement outcome unknown. An
  error response is not proof of no charge. Reconcile before retrying a payment.
- `/healthz` is process liveness, not proof of upstream/facilitator readiness.
  Use `/readyz` to check that the facilitator is reachable and offers the
  configured network, x402 v2 and exact scheme. Each probe contacts the facilitator;
  use an appropriate probe interval. It does not verify upstream health or actual settlement.
- Every response carries an `X-Request-ID` header. Send your own `x-request-id`
  (letters, digits, `.`, `_`, `~`, `-`, up to 128 chars) and it is echoed back and
  forwarded upstream so agent, wrapper and upstream logs correlate; unsafe
  values are replaced with a minted UUID in the response and stripped upstream.
  IDs are caller-controlled correlation labels, not authentication or payment deduplication keys.
  Generated IDs label the wrapper response; they are not injected upstream.
- The CLI disables Bun's short idle timeout so it does not disconnect a client
  during settlement. SDK facilitator calls default to a configurable 90-second timeout;
  deploy behind a reverse proxy with suitable request deadlines and rate limits.

## Verification

### Concurrency admission (added in 0.2.0)

`MAX_CONCURRENT_REQUESTS` defaults to 64 and accepts integers from 1 to 10000.
The limit is per `createApp()` instance, covering every `/v1/*` request from
facilitator initialization through verification, upstream handling and settlement.
Overflow returns `503 {"error":"service_busy"}`, `Retry-After: 1` and
`Cache-Control: no-store` before any payment verification or upstream call.
Requests are not queued. Slots are released on completion or failure; `/healthz`
and unrelated routes do not consume slots. Unpaid challenges also count.

This is a concurrency bound, not a distributed rate limiter, payment replay
defense or idempotency mechanism. Replicas have separate limits. Tune the value
for upstream capacity and response sizes; use edge rate limits for hostile traffic.
Do not treat every 503 as safe to retry: only this wrapper's `service_busy`
response denotes pre-payment rejection. Settlement errors still need reconciliation.

### Facilitator deadlines (added in 0.3.0)

`FACILITATOR_TIMEOUT_MS` accepts integers from 1 to 300000, default 90000.
It configures the official SDK HTTP client's timeout for each `/supported`,
`/verify` and `/settle` attempt, including response-body consumption. This is
separate from `UPSTREAM_TIMEOUT_MS`; it is not a total request deadline. The SDK
may retry `/supported` on HTTP 429 with backoff, so initialization can take longer.
Custom injected facilitators own their own cancellation and timeout policy.

An initialization timeout returns 503 `facilitator_unavailable`. Verification
and settlement timeouts return SDK 502 errors. Verification timeout does not call
the upstream or settle. Settlement timeout withholds the protected response, but
the upstream already ran and the facilitator may have completed the charge.
There is no automatic retry of verification or settlement. Reconcile an unknown
settlement before retrying. Slots are released when requests finish, and health
checks remain available. Lowering the timeout increases indeterminate outcomes
for slow settlements; choose a deadline suitable for your deployment.

### Stream cleanup (fixed in 0.3.1)

Rejected oversized bodies, refused redirects and aborted reads request stream
cancellation without waiting for producer cleanup. A stalled or rejected cleanup
promise cannot hold a concurrency slot or replace the original HTTP error.
Readers release their locks on success and failure; successful bodies retain their
original bytes. Cleanup is best-effort: an injected stream producer still owns its
underlying resources. This does not cancel or undo payment settlement, and does
not add payment retries.

### CORS support (added in 0.3.2)

Configure `CORS_ORIGIN` with `*` or a specific origin (e.g. `https://agent.kite.ai`)
to enable web browsers, dApps, and AI agent frontends to make paid cross-origin calls:

- Preflight `OPTIONS` requests receive `204 No Content` with appropriate
  `Access-Control-Allow-*` headers without triggering payment middleware.
  Only OPTIONS with Origin and Access-Control-Request-Method is preflight;
  other OPTIONS requests still require payment. Upstream CORS headers are stripped
  so the wrapper controls origin policy. CORS is not server-side authentication.
- `402 Payment Required` challenge responses and successful responses expose
  `Payment-Required`, `Payment-Response`, `Retry-After`, `X-Request-ID`, `X-Response-Time`, allowing browser `fetch`
  clients to inspect payment requirements and payment settlement tokens.
- When `CORS_ORIGIN` is unset (the default), CORS middleware is omitted entirely
  with zero overhead and backwards-compatible behavior.

### Graceful shutdown (added in 0.3.3)

On receiving `SIGINT` or `SIGTERM` (e.g. during container restarts or deployments),
the CLI server immediately stops accepting new connections via `server.stop(false)`,
allowing in-flight paid requests and settlement handshakes to drain cleanly before
the process exits. If in-flight requests do not complete within `SHUTDOWN_TIMEOUT_MS`
(default 10000ms), connections are forcibly closed to prevent hanging deployments.

### Liveness probe and timing instrumentation (added in 0.3.3)

- `GET /livez`: Standard Kubernetes liveness probe that immediately returns `200 {"ok":true,"status":"alive"}` with `Cache-Control: no-store`. It requires zero network I/O and runs completely independently of facilitator availability, preventing container restart loops during transient facilitator downtime.
- `X-Response-Time`: Measures total end-to-end request duration through the wrapper (formatted as `${ms}ms`), allowing cloud monitoring tools and browser dApps (via CORS `Access-Control-Expose-Headers`) to distinguish wrapper processing latency from upstream execution and on-chain payment settlement.

### Commands

```sh
npm run typecheck
bun test --coverage
npm run build
npm audit --omit=dev --audit-level=high
npm pack
```

Tests exercise the real x402 Hono middleware. A deterministic fake facilitator
supplies verification/settlement results; a separate HTTP test runs the SDK
client against local `/v2/supported`, `/v2/verify`, `/v2/settle` endpoints and
proxies real HTTP requests. Fixtures are clearly labeled and are **not valid
signatures or evidence of on-chain payment**. CI publishes coverage, JUnit and
the installable package artifact, and tests installing that artifact separately.

For real paid acceptance, deploy a public HTTPS origin, replace PAY_TO, use a
Kite Passport sandbox session with testnet pieUSD, and retain the real response
and transaction hash. Follow the current Passport CLI documentation because its
commands evolve. No mainnet transaction is required for local development.

## Release and contribution

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and
[docs/week-1.md](docs/week-1.md) for the bounty scope and evidence checklist.
AI tools assisted development; BrK reviews and owns the contribution. Original
wrapper/configuration/test work is distinguished from upstream SDK functionality.
