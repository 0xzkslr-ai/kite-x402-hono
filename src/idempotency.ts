export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:~-]{1,128}$/;

export interface CachedResponse {
  statusCode: number;
  headers: [string, string][];
  body: Uint8Array;
  cachedAt: number;
  expiresAt: number;
}

interface InFlightEntry {
  state: "in_flight";
  fingerprint: string | undefined;
  startedAt: number;
  expiresAt: number;
}

interface CompletedEntry {
  state: "completed";
  fingerprint: string | undefined;
  response: CachedResponse;
}

type IdempotencyRecord = InFlightEntry | CompletedEntry;

export interface IdempotencyCacheOptions {
  ttlMs?: number;
  maxKeys?: number;
  maxBytes?: number;
}

export class IdempotencyCache {
  private records = new Map<string, IdempotencyRecord>();
  private defaultTtlMs: number;
  private maxKeys: number;
  private maxBytes: number;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.maxKeys = options.maxKeys ?? 1000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    for (const n of [this.defaultTtlMs, this.maxKeys, this.maxBytes])
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error("Invalid cache limit");
  }

  public validateKey(key: string | null | undefined): boolean {
    if (!key) return false;
    return IDEMPOTENCY_KEY_PATTERN.test(key);
  }

  public cleanExpired(now = Date.now()): void {
    for (const [key, record] of this.records.entries()) {
      const expiresAt =
        record.state === "in_flight"
          ? record.expiresAt
          : record.response.expiresAt;
      if (now >= expiresAt) {
        this.records.delete(key);
      }
    }
  }

  /** A supplied fingerprint must match for both in-flight and completed requests. */
  public acquire(
    key: string,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
    fingerprint?: string,
  ):
    | { status: "acquired" }
    | { status: "conflict" }
    | { status: "in_flight" }
    | { status: "cached"; response: CachedResponse } {
    this.cleanExpired(now);

    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { status: "conflict" };
      }
      if (existing.state === "in_flight") {
        return { status: "in_flight" };
      }
      return { status: "cached", response: existing.response };
    }

    if (this.records.size >= this.maxKeys) {
      // Evict oldest record
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }

    this.records.set(key, {
      state: "in_flight",
      fingerprint,
      startedAt: now,
      expiresAt: now + Math.max(ttlMs, 600000), // 30s timeout for in-flight requests
    });

    return { status: "acquired" };
  }

  public complete(
    key: string,
    statusCode: number,
    headers: Headers,
    body: Uint8Array,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
  ): void {
    const record = this.records.get(key);
    if (!record) return;
    const used = [...this.records.entries()].reduce(
      (n, [k, r]) =>
        n +
        (k !== key && r.state === "completed" ? r.response.body.byteLength : 0),
      0,
    );
    if (used + body.byteLength > this.maxBytes) {
      this.records.delete(key);
      return;
    }
    const headerEntries: [string, string][] = [];
    headers.forEach((val, name) => {
      // Don't cache transfer-encoding, connection, or hop-by-hop headers
      const lower = name.toLowerCase();
      if (
        [
          "content-type",
          "content-language",
          "etag",
          "last-modified",
          "payment-response",
        ].includes(lower)
      ) {
        headerEntries.push([name, val]);
      }
    });

    this.records.set(key, {
      state: "completed",
      fingerprint: record.fingerprint,
      response: {
        statusCode,
        headers: headerEntries,
        body,
        cachedAt: now,
        expiresAt: now + ttlMs,
      },
    });
  }

  public release(key: string): void {
    const existing = this.records.get(key);
    if (existing && existing.state === "in_flight") {
      this.records.delete(key);
    }
  }

  public size(): number {
    return this.records.size;
  }

  public clear(): void {
    this.records.clear();
  }
}
