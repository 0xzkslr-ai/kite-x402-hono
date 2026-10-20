/**
 * In-memory sliding-window nonce replay protection for x402 payments.
 *
 * Prevents malicious or accidental reuse of EIP-3009 payment authorizations
 * by tracking (payer, nonce) pairs and protecting against concurrent in-flight replays.
 */

export interface NonceGuardOptions {
  /**
   * Sliding window TTL for consumed nonces in milliseconds.
   * Default: 15 minutes (900,000 ms).
   */
  consumedTtlMs?: number;

  /**
   * Maximum lease timeout for in-flight requests in milliseconds.
   * If a request crashes or fails before settlement/rejection, the lease expires.
   * Default: 60 seconds (60,000 ms).
   */
  inFlightTtlMs?: number;

  /**
   * Maximum tracked entries before opportunistic purge.
   * Default: 10,000.
   */
  maxEntries?: number;
}

export type NonceStatus = "CONSUMED" | "IN_FLIGHT" | "AVAILABLE";

export interface NonceEntry {
  status: "CONSUMED" | "IN_FLIGHT";
  expiresAt: number;
}

export class PaymentNonceReplayGuard {
  private readonly consumedTtlMs: number;
  private readonly inFlightTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, NonceEntry>();

  constructor(options: NonceGuardOptions = {}) {
    this.consumedTtlMs = options.consumedTtlMs ?? 15 * 60 * 1000;
    this.inFlightTtlMs = options.inFlightTtlMs ?? 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  private buildKey(payer: string, nonce: string): string {
    return `${payer.trim().toLowerCase()}:${nonce.trim().toLowerCase()}`;
  }

  /**
   * Attempts to acquire an in-flight lease for the given (payer, nonce).
   * Returns true if acquired, false if already consumed or currently in-flight.
   */
  public acquire(payer: string, nonce: string, now: number = Date.now()): boolean {
    this.cleanExpired(now);
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);

    if (existing) {
      if (existing.expiresAt > now) {
        return false; // Replay attempt detected!
      }
      this.entries.delete(key);
    }

    if (this.entries.size >= this.maxEntries) {
      this.forcePurgeOldest();
    }

    this.entries.set(key, {
      status: "IN_FLIGHT",
      expiresAt: now + this.inFlightTtlMs,
    });
    return true;
  }

  /**
   * Commits the nonce as permanently consumed upon successful payment settlement.
   */
  public commit(payer: string, nonce: string, now: number = Date.now()): void {
    const key = this.buildKey(payer, nonce);
    this.entries.set(key, {
      status: "CONSUMED",
      expiresAt: now + this.consumedTtlMs,
    });
  }

  /**
   * Releases an in-flight lease if verification or proxying failed before settlement.
   */
  public release(payer: string, nonce: string): void {
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);
    if (existing && existing.status === "IN_FLIGHT") {
      this.entries.delete(key);
    }
  }

  /**
   * Queries status of a given (payer, nonce).
   */
  public check(payer: string, nonce: string, now: number = Date.now()): NonceStatus {
    const key = this.buildKey(payer, nonce);
    const existing = this.entries.get(key);
    if (!existing || existing.expiresAt <= now) {
      return "AVAILABLE";
    }
    return existing.status;
  }

  /**
   * Returns current count of active tracked nonces.
   */
  public size(now: number = Date.now()): number {
    this.cleanExpired(now);
    return this.entries.size;
  }

  /**
   * Clears all entries.
   */
  public clear(): void {
    this.entries.clear();
  }

  private cleanExpired(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private forcePurgeOldest(): void {
    const toDelete = Math.max(1, Math.floor(this.maxEntries * 0.1));
    let count = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      count++;
      if (count >= toDelete) break;
    }
  }
}
