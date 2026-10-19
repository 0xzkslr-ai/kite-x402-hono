import type { MiddlewareHandler } from "hono";

export type LogFormat = "json" | "dev";

export interface LoggerConfig {
  format?: LogFormat | undefined;
  enabled?: boolean | undefined;
  skipHealthz?: boolean | undefined;
  redactHeaders?: string[] | undefined;
}

export interface AccessLogEntry {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  clientIp: string | null;
  contentLength: number | null;
  userAgent: string | null;
}

export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    const client = first ? first.trim() : "";
    if (client.length > 0) return client;
  }

  const realIp = headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  const cfIp = headers.get("cf-connecting-ip");
  if (cfIp && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  return null;
}

export function formatLogEntry(entry: AccessLogEntry, format: LogFormat): string {
  if (format === "json") {
    return JSON.stringify(entry);
  }

  const statusStr = entry.status >= 500
    ? `\x1b[31m${entry.status}\x1b[0m`
    : entry.status >= 400
      ? `\x1b[33m${entry.status}\x1b[0m`
      : `\x1b[32m${entry.status}\x1b[0m`;

  const ipStr = entry.clientIp ? ` (${entry.clientIp})` : "";
  return `[${entry.timestamp}] ${statusStr} ${entry.method} ${entry.path} - ${entry.durationMs.toFixed(2)}ms${ipStr} [${entry.requestId}]`;
}

export function createAccessLogger(
  config: LoggerConfig = {},
  sink: (line: string) => void = console.log
): MiddlewareHandler {
  const enabled = config.enabled ?? true;
  const format = config.format ?? "json";
  const skipHealthz = config.skipHealthz ?? true;

  if (!enabled) {
    return async (_c, next) => next();
  }

  return async (c, next) => {
    const path = c.req.path;
    if (skipHealthz && (path === "/healthz" || path === "/healthz/")) {
      return next();
    }

    const start = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    const rawContentLength = c.res.headers.get("content-length");
    const contentLength = rawContentLength && /^\d+$/.test(rawContentLength)
      ? Number(rawContentLength)
      : null;

    const entry: AccessLogEntry = {
      timestamp: new Date().toISOString(),
      requestId: c.res.headers.get("x-request-id") ?? "unknown",
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs,
      clientIp: extractClientIp(c.req.raw.headers),
      contentLength,
      userAgent: c.req.header("user-agent") ?? null,
    };

    try {
      sink(formatLogEntry(entry, format));
    } catch {
      // Logging should never throw or disrupt response delivery
    }
  };
}
