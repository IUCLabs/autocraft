// Limits for expensive work: a token bucket per key (for GET endpoints that
// aggregate the mirror or run the embedder) and a counting semaphore with a
// bounded wait (for upstream image fetches and embeddings).

/** Refills `perSec` tokens a second up to `burst`; `take` spends one. */
export class TokenBucket {
  #buckets = new Map<string, { tokens: number; at: number }>();
  #burst: number;
  #perSec: number;
  constructor(burst: number, perSec: number) {
    this.#burst = burst;
    this.#perSec = perSec;
  }
  /** Seconds to wait before a token is available, or 0 when one was taken. */
  take(key: string, now = Date.now()): number {
    if (this.#buckets.size > 10_000) {
      for (const [k, b] of this.#buckets) if (b.tokens + ((now - b.at) / 1000) * this.#perSec >= this.#burst) this.#buckets.delete(k);
    }
    const b = this.#buckets.get(key) ?? { tokens: this.#burst, at: now };
    b.tokens = Math.min(this.#burst, b.tokens + ((now - b.at) / 1000) * this.#perSec);
    b.at = now;
    this.#buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.#perSec));
  }
}

/** At most `max` holders at once; later callers wait up to `waitMs` in order. */
export class Semaphore {
  #free: number;
  #waiters: ((release: (() => void) | null) => void)[] = [];
  #waitMs: number;
  constructor(max: number, waitMs: number) {
    this.#free = max;
    this.#waitMs = waitMs;
  }
  /** A release function, or null when the wait ran out. */
  acquire(): Promise<(() => void) | null> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve) => {
      const waiter = (r: (() => void) | null) => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        resolve(null);
      }, this.#waitMs);
      this.#waiters.push(waiter);
    });
  }
  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiters.shift();
      if (next) next(this.#releaser());
      else this.#free++;
    };
  }
}
