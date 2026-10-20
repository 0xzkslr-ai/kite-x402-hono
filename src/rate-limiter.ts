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
    if (
      options.refillRatePerSec <= 0 ||
      !Number.isFinite(options.refillRatePerSec)
    ) {
      throw new Error(
        "Rate limiter refillRatePerSec must be a positive finite number",
      );
    }
    this.capacity = options.capacity;
    this.refillRatePerSec = options.refillRatePerSec;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 300_000; // 5 min
    this.lastCleanupMs = 0;
  }

  /**
   * Attempts to consume tokens from the bucket for the specified client key.
   */
  public consume(
    key: string,
    tokensToConsume = 1,
    nowMs = Date.now(),
  ): RateLimitStatus {
    if (!Number.isFinite(tokensToConsume) || tokensToConsume <= 0)
      throw new Error("Invalid token count");
    this.maybeCleanup(nowMs);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10000)
        return {
          allowed: false,
          remaining: 0,
          limit: this.capacity,
          resetInSec: 1,
        };
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
        (this.capacity - bucket.tokens) / this.refillRatePerSec,
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
  options: RateLimiterOptions,
): MiddlewareHandler {
  const limiter = new AdaptiveRateLimiter(options);
  const keyExtractor = options.keyExtractor ?? (() => "global");

  return async (c, next) => {
    c.header("cache-control", "no-store");
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
          message:
            "Rate limit exceeded. Please retry after the cooling window.",
          retryAfterSec: status.resetInSec,
        },
        429,
      );
    }

    await next();
  };
}

export interface TokenBucketOptions {
  rps: number;
  burst?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
  limit: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private readonly rps: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.rps) || options.rps <= 0) {
      throw new Error("Rate limit RPS must be greater than zero");
    }
    this.rps = options.rps;
    this.burst =
      options.burst && options.burst >= options.rps
        ? options.burst
        : options.rps * 2;
  }

  public getLimit(): number {
    return this.rps;
  }

  public getBurst(): number {
    return this.burst;
  }

  public consume(key: string, now: number = Date.now()): RateLimitDecision {
    let state = this.buckets.get(key);
    if (!state) {
      if (this.buckets.size >= 10000)
        return {
          allowed: false,
          remaining: 0,
          resetSeconds: 1,
          limit: this.rps,
        };
      state = {
        tokens: this.burst,
        lastRefill: now,
      };
      this.buckets.set(key, state);
    } else {
      const elapsedMs = Math.max(0, now - state.lastRefill);
      const elapsedSec = elapsedMs / 1000;
      const tokensToAdd = elapsedSec * this.rps;
      state.tokens = Math.min(this.burst, state.tokens + tokensToAdd);
      state.lastRefill = now;
    }

    if (state.tokens >= 1) {
      state.tokens -= 1;
      const resetSeconds = Math.ceil((this.burst - state.tokens) / this.rps);
      return {
        allowed: true,
        remaining: Math.floor(state.tokens),
        resetSeconds: Math.max(1, resetSeconds),
        limit: this.rps,
      };
    }

    // Rate limited
    const needed = 1 - state.tokens;
    const retryAfter = Math.max(1, Math.ceil(needed / this.rps));
    return {
      allowed: false,
      remaining: 0,
      resetSeconds: retryAfter,
      limit: this.rps,
    };
  }

  public reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }

  public size(): number {
    return this.buckets.size;
  }
}
