export interface RateLimiterOptions {
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

  constructor(options: RateLimiterOptions) {
    if (options.rps <= 0) {
      throw new Error("Rate limit RPS must be greater than zero");
    }
    this.rps = options.rps;
    this.burst = options.burst && options.burst >= options.rps ? options.burst : options.rps * 2;
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
