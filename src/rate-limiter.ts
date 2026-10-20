import type { Context, MiddlewareHandler } from "hono";

export interface RateLimiterOptions {
  /** Maximum number of tokens available in the bucket (burst capacity). */
  capacity: number;
  /** Number of tokens refilled per second. */
  refillRatePerSec: number;
  /** Cleanup interval in milliseconds for purging stale client buckets. */
  cleanupIntervalMs?: number;
  /** Custom key extractor (defaults to client IP or 'unknown'). */
  keyExtractor?: (c: Context) => string;
}

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetInSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastAccessMs: number;
}

/**
 * In-memory Token Bucket Rate Limiter with sub-second precision and sliding refill.
 */
export class AdaptiveRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  public readonly capacity: number;
  public readonly refillRatePerSec: number;
  private readonly cleanupIntervalMs: number;
  private lastCleanupMs: number;

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0 || !Number.isFinite(options.capacity)) {
      throw new Error("Rate limiter capacity must be a positive finite number");
    }
    if (options.refillRatePerSec <= 0 || !Number.isFinite(options.refillRatePerSec)) {
      throw new Error("Rate limiter refillRatePerSec must be a positive finite number");
    }
    this.capacity = options.capacity;
    this.refillRatePerSec = options.refillRatePerSec;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 300_000; // 5 min
    this.lastCleanupMs = 0;
  }

  /**
   * Attempts to consume tokens from the bucket for the specified client key.
   */
  public consume(key: string, tokensToConsume = 1, nowMs = Date.now()): RateLimitStatus {
    this.maybeCleanup(nowMs);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: this.capacity,
        lastRefillMs: nowMs,
        lastAccessMs: nowMs,
      };
      this.buckets.set(key, bucket);
    } else {
      // Calculate token refill
      const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
      if (elapsedSec > 0) {
        const refilled = elapsedSec * this.refillRatePerSec;
        bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
        bucket.lastRefillMs = nowMs;
      }
      bucket.lastAccessMs = nowMs;
    }

    if (bucket.tokens >= tokensToConsume) {
      bucket.tokens -= tokensToConsume;
      const resetInSec = Math.ceil(
        (this.capacity - bucket.tokens) / this.refillRatePerSec
      );
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: this.capacity,
        resetInSec: Math.max(0, resetInSec),
      };
    }

    const deficit = tokensToConsume - bucket.tokens;
    const resetInSec = Math.ceil(deficit / this.refillRatePerSec);
    return {
      allowed: false,
      remaining: 0,
      limit: this.capacity,
      resetInSec: Math.max(1, resetInSec),
    };
  }

  /**
   * Resets rate limit for a specific key (useful in testing or administrative resets).
   */
  public reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Purges buckets that haven't been accessed for more than the cleanup interval.
   */
  private maybeCleanup(nowMs: number): void {
    if (nowMs - this.lastCleanupMs < this.cleanupIntervalMs) return;
    this.lastCleanupMs = nowMs;
    const staleThreshold = nowMs - this.cleanupIntervalMs;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.lastAccessMs < staleThreshold) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Total number of active rate-limited client keys.
   */
  public get activeClientCount(): number {
    return this.buckets.size;
  }
}

/**
 * Creates a Hono middleware handler for adaptive rate limiting.
 */
export function createRateLimiterMiddleware(
  options: RateLimiterOptions
): MiddlewareHandler {
  const limiter = new AdaptiveRateLimiter(options);
  const defaultKeyExtractor = (c: Context): string => {
    return (
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "127.0.0.1"
    );
  };
  const keyExtractor = options.keyExtractor ?? defaultKeyExtractor;

  return async (c, next) => {
    const key = keyExtractor(c);
    const status = limiter.consume(key);

    c.header("X-RateLimit-Limit", status.limit.toString());
    c.header("X-RateLimit-Remaining", status.remaining.toString());
    c.header("X-RateLimit-Reset", status.resetInSec.toString());

    if (!status.allowed) {
      c.header("Retry-After", status.resetInSec.toString());
      return c.json(
        {
          error: "too_many_requests",
          message: "Rate limit exceeded. Please retry after the cooling window.",
          retryAfterSec: status.resetInSec,
        },
        429
      );
    }

    await next();
  };
}
