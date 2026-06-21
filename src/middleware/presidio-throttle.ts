import { getConfig } from "../config";

class PresidioSemaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

let presidioSemaphore: PresidioSemaphore | null = null;

function getPresidioSemaphore(): PresidioSemaphore {
  if (!presidioSemaphore) {
    const config = getConfig();
    presidioSemaphore = new PresidioSemaphore(config.server.presidio_max_concurrent);
  }
  return presidioSemaphore;
}

export async function throttledPresidioCall<T>(fn: () => Promise<T>): Promise<T> {
  const sem = getPresidioSemaphore();
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}
