export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:~-]{1,128}$/;

export interface CachedResponse {
  statusCode: number;
  headers: [string, string][];
  body: Uint8Array;
  cachedAt: number;
  expiresAt: number;
}

interface InFlightEntry {
  state: 'in_flight';
  startedAt: number;
  expiresAt: number;
}

interface CompletedEntry {
  state: 'completed';
  response: CachedResponse;
}

type IdempotencyRecord = InFlightEntry | CompletedEntry;

export interface IdempotencyCacheOptions {
  ttlMs?: number;
  maxKeys?: number;
}

export class IdempotencyCache {
  private records = new Map<string, IdempotencyRecord>();
  private defaultTtlMs: number;
  private maxKeys: number;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.maxKeys = options.maxKeys ?? 10000;
  }

  public validateKey(key: string | null | undefined): boolean {
    if (!key) return false;
    return IDEMPOTENCY_KEY_PATTERN.test(key);
  }

  public cleanExpired(now = Date.now()): void {
    for (const [key, record] of this.records.entries()) {
      const expiresAt =
        record.state === 'in_flight'
          ? record.expiresAt
          : record.response.expiresAt;
      if (now >= expiresAt) {
        this.records.delete(key);
      }
    }
  }

  public acquire(
    key: string,
    ttlMs = this.defaultTtlMs,
    now = Date.now()
  ): { status: 'acquired' } | { status: 'in_flight' } | { status: 'cached'; response: CachedResponse } {
    this.cleanExpired(now);

    const existing = this.records.get(key);
    if (existing) {
      if (existing.state === 'in_flight') {
        return { status: 'in_flight' };
      }
      return { status: 'cached', response: existing.response };
    }

    if (this.records.size >= this.maxKeys) {
      // Evict oldest record
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }

    this.records.set(key, {
      state: 'in_flight',
      startedAt: now,
      expiresAt: now + 30000, // 30s timeout for in-flight requests
    });

    return { status: 'acquired' };
  }

  public complete(
    key: string,
    statusCode: number,
    headers: Headers,
    body: Uint8Array,
    ttlMs = this.defaultTtlMs,
    now = Date.now()
  ): void {
    const headerEntries: [string, string][] = [];
    headers.forEach((val, name) => {
      // Don't cache transfer-encoding, connection, or hop-by-hop headers
      const lower = name.toLowerCase();
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lower)) {
        headerEntries.push([name, val]);
      }
    });

    this.records.set(key, {
      state: 'completed',
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
    if (existing && existing.state === 'in_flight') {
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
