import { createMiddleware } from "hono/factory";

class Semaphore {
  private permits: number;
  private queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.permits > 0) {
      this.permits--;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolver);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const resolver = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.queue.push({ resolve: resolver, timer });
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.permits++;
    }
  }
}

let concurrencySemaphore: Semaphore | null = null;

export function initConcurrencyLimiter(maxConcurrent: number): void {
  concurrencySemaphore = new Semaphore(maxConcurrent);
}

export function getConcurrencySemaphore(): Semaphore | null {
  return concurrencySemaphore;
}

export function createConcurrencyMiddleware(maxConcurrent: number, maxQueue: number, queueTimeoutMs: number) {
  const semaphore = new Semaphore(maxConcurrent);
  const waitingCount = { value: 0 };

  return createMiddleware(async (c, next) => {
    if (waitingCount.value >= maxQueue) {
      return c.json({ error: { message: "Server busy, queue full", type: "queue_full" } }, 503);
    }

    waitingCount.value++;
    try {
      const acquired = await semaphore.acquire(queueTimeoutMs);
      if (!acquired) {
        return c.json({ error: { message: "Request timed out waiting for capacity", type: "queue_timeout" } }, 503);
      }
      try {
        await next();
      } finally {
        semaphore.release();
      }
    } finally {
      waitingCount.value--;
    }
  });
}
