import type { Config } from "./config.js";

export type FetchUpstream = (request: Request) => Promise<Response>;

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

const blocked = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
  "proxy-authorization",
  "proxy-authenticate",
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-payment",
  "x-payment-response",
  "x-payment-required",
  "cookie",
  "set-cookie",
  "authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

export function cleanHeaders(source: Headers, authHeader: string): Headers {
  const headers = new Headers(source);
  const connectionTokens = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  for (const key of [...headers.keys()]) {
    if (
      blocked.has(key) ||
      (key === "x-request-id" &&
        !REQUEST_ID_PATTERN.test(headers.get(key) ?? "")) ||
      key === authHeader ||
      connectionTokens.includes(key) ||
      key.startsWith("x402-") ||
      key.startsWith("access-control-")
    )
      headers.delete(key);
  }
  return headers;
}

class BodyTooLarge extends Error {}

export async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  let completed = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    // Cleanup belongs to the stream producer and must not block a failure response.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        completed = true;
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function proxy(
  request: Request,
  config: Config,
  fetchUpstream: FetchUpstream,
): Promise<Response> {
  const incoming = new URL(request.url);
  // Assign pathname rather than resolving user input: //host must never replace the configured origin.
  const target = new URL(config.upstream);
  target.pathname = incoming.pathname.slice(3) || "/";
  target.search = incoming.search;
  const headers = cleanHeaders(request.headers, config.authHeader);
  headers.set("accept-encoding", "identity");
  if (config.authValue) headers.set(config.authHeader, config.authValue);
  let body: Uint8Array<ArrayBuffer> | undefined;
  const bodyController = new AbortController();
  const onBodyAbort = () => bodyController.abort(request.signal.reason);
  request.signal.addEventListener("abort", onBodyAbort, { once: true });
  if (request.signal.aborted) bodyController.abort(request.signal.reason);
  const bodyTimer = setTimeout(
    () =>
      bodyController.abort(
        new DOMException("The operation timed out.", "TimeoutError"),
      ),
    config.timeoutMs,
  );
  try {
    if (!["GET", "HEAD"].includes(request.method))
      body = await readLimited(
        request.body,
        config.maxBodyBytes,
        bodyController.signal,
      );
  } catch (error) {
    if (bodyController.signal.aborted)
      return Response.json(
        { error: "request_timeout_or_abort" },
        { status: 408 },
      );
    return Response.json(
      {
        error:
          error instanceof BodyTooLarge
            ? "request_too_large"
            : "invalid_request_body",
      },
      { status: error instanceof BodyTooLarge ? 413 : 400 },
    );
  } finally {
    clearTimeout(bodyTimer);
    request.signal.removeEventListener("abort", onBodyAbort);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const upstream = await fetchUpstream(
      new Request(target, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: controller.signal,
        redirect: "manual",
      }),
    );
    // Only 304 is a supported non-2xx success; refuse other 3xx without settlement.
    // Never follow redirects with the injected credential.
    if (
      upstream.status >= 300 &&
      upstream.status < 400 &&
      upstream.status !== 304
    ) {
      void upstream.body?.cancel().catch(() => {});
      return Response.json(
        { error: "upstream_redirect_refused" },
        { status: 502 },
      );
    }
    const bytes = await readLimited(
      upstream.body,
      config.maxBodyBytes,
      controller.signal,
    );
    const responseHeaders = cleanHeaders(upstream.headers, config.authHeader);
    responseHeaders.delete("content-encoding");
    responseHeaders.set("cache-control", "no-store");
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(upstream.status)
        ? null
        : bytes,
      { status: upstream.status, headers: responseHeaders },
    );
  } catch (error) {
    const timeout = controller.signal.aborted;
    return Response.json(
      {
        error: timeout
          ? "upstream_timeout_or_abort"
          : error instanceof BodyTooLarge
            ? "upstream_response_too_large"
            : "upstream_unavailable",
      },
      { status: timeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
