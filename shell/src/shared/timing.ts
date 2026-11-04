// Small timing helpers shared by the main process and tests.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Retries probe until it resolves or the timeout passes, then rethrows the last error.
export async function wait_for<T>(probe: () => Promise<T>, timeout_ms: number, interval_ms = 100): Promise<T> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    try {
      return await probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await sleep(interval_ms)
  }
}

// Allows one automatic run per key per interval; forced runs always pass and reset the clock.
export class Throttle {
  private readonly last_run = new Map<string, number>()

  constructor(
    readonly interval_ms: number,
    private readonly clock: () => number = Date.now,
  ) {}

  allow(key: string, force: boolean): boolean {
    const now = this.clock()
    const last = this.last_run.get(key)
    if (!force && last !== undefined && now - last < this.interval_ms) return false
    this.last_run.set(key, now)
    return true
  }
}
