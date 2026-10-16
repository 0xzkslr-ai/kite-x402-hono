import {
  KITE_NETWORKS,
  parsePrice,
  resolveNetwork,
  type KiteNetwork,
} from "./networks.js";

export interface Config {
  payTo: string;
  chain: KiteNetwork;
  upstream: string;
  price: string;
  facilitatorUrl: string;
  authHeader: string;
  authValue: string;
  description: string;
  port: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxConcurrentRequests?: number;
  facilitatorTimeoutMs?: number;
  corsOrigin?: string | undefined;
}

export function parseCorsOrigin(value: string): string {
  if (value === "*") return "*";
  return httpUrl(value, "CORS_ORIGIN", true);
}

function integer(value: string, key: string, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${key} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

function httpUrl(value: string, key: string, originOnly = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== "/")
  ) {
    throw new Error(
      `${key} must be an HTTP(S) ${originOnly ? "origin" : "URL"} without credentials, query or fragment`,
    );
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(`${key} requires HTTPS except on localhost`);
  }
  return originOnly ? url.origin : url.href.replace(/\/$/, "");
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const get = (key: string, fallback = "") => env[key]?.trim() || fallback;
  const payTo = get("PAY_TO");
  if (!/^0x[\da-fA-F]{40}$/.test(payTo) || /^0x0{40}$/i.test(payTo))
    throw new Error("PAY_TO must be a nonzero EVM address");
  const networkInput = get("KITE_NETWORK", "mainnet");
  const chain = resolveNetwork(networkInput);
  if (!chain) {
    throw new Error(
      "KITE_NETWORK must be mainnet, testnet, or a recognized Kite chain ID (2366, 2368, eip155:2366, eip155:2368)",
    );
  }
  const price = get("PRICE_USD", "0.001").replace(/^\$/, "");
  parsePrice(price, chain);
  const authHeader = get("UPSTREAM_AUTH_HEADER", "Authorization").toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~\da-z-]+$/.test(authHeader) ||
    [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "payment-signature",
      "payment-response",
      "payment-required",
      "x-payment",
      "x-payment-response",
      "cookie",
      "set-cookie",
      "proxy-authorization",
      "proxy-authenticate",
      "content-encoding",
      "accept-encoding",
      "upgrade",
      "te",
      "trailer",
      "keep-alive",
    ].includes(authHeader)
  ) {
    throw new Error(
      "UPSTREAM_AUTH_HEADER must be a valid application authentication header",
    );
  }
  const authValue = get("UPSTREAM_AUTH_VALUE");
  if (/[\r\n\0]/.test(authValue))
    throw new Error("UPSTREAM_AUTH_VALUE contains invalid characters");
  return {
    payTo,
    chain,
    price,
    authHeader,
    authValue,
    upstream: httpUrl(get("UPSTREAM_URL"), "UPSTREAM_URL", true),
    facilitatorUrl: httpUrl(
      get("FACILITATOR_URL", "https://facilitator.pieverse.io/v2"),
      "FACILITATOR_URL",
    ),
    description: get(
      "SERVICE_DESCRIPTION",
      "Paid API wrapped for the Kite network",
    ),
    port: integer(get("PORT", "8080"), "PORT", 65535),
    timeoutMs: integer(
      get("UPSTREAM_TIMEOUT_MS", "10000"),
      "UPSTREAM_TIMEOUT_MS",
      120000,
    ),
    maxBodyBytes: integer(
      get("MAX_BODY_BYTES", "1048576"),
      "MAX_BODY_BYTES",
      16777216,
    ),
    maxConcurrentRequests: integer(
      get("MAX_CONCURRENT_REQUESTS", "64"),
      "MAX_CONCURRENT_REQUESTS",
      10000,
    ),
    facilitatorTimeoutMs: integer(
      get("FACILITATOR_TIMEOUT_MS", "90000"),
      "FACILITATOR_TIMEOUT_MS",
      300000,
    ),
    corsOrigin: get("CORS_ORIGIN")
      ? parseCorsOrigin(get("CORS_ORIGIN"))
      : undefined,
  };
}
