/**
 * In-memory token bucket, 60 requests/min/IP, applied to public POSTs that
 * would otherwise let anyone hammer the service for free (PLAN §12) — today
 * that's `/v1/consent/{consentKey}/revoke`.
 */
const CAPACITY = 60;
const REFILL_MS = 60_000; // full bucket refills once per minute

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private capacity = CAPACITY, private refillMs = REFILL_MS) {}

  /** Returns true if the request is allowed (and consumes a token). */
  allow(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, b);
    }
    const elapsed = now - b.updatedAt;
    if (elapsed > 0) {
      const refill = (elapsed / this.refillMs) * this.capacity;
      b.tokens = Math.min(this.capacity, b.tokens + refill);
      b.updatedAt = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
