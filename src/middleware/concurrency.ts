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
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.permits++;
    }
  }
}

export function createConcurrencyMiddleware(
  maxConcurrent: number = 10,
  maxQueue: number = 50,
  queueTimeoutMs: number = 30000,
) {
  const semaphore = new Semaphore(maxConcurrent);

  return createMiddleware(async (c, next) => {
    const acquired = await semaphore.acquire(queueTimeoutMs);
    if (!acquired) {
      return c.json(
        {
          error: {
            message: "Server is busy, too many concurrent requests",
            type: "server_busy",
          },
        },
        503,
      );
    }

    try {
      await next();
    } finally {
      semaphore.release();
    }
  });
}
