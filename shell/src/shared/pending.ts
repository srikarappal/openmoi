// Matches asynchronous responses to requests by id, with a timeout per request.

interface Waiter {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PendingRequests {
  private next_id = 1
  private readonly waiters = new Map<number, Waiter>()

  create<T>(timeout_ms: number, label: string): { request_id: number; promise: Promise<T> } {
    const request_id = this.next_id++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request_id)
        reject(new Error(`${label} timed out`))
      }, timeout_ms)
      this.waiters.set(request_id, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
    return { request_id, promise }
  }

  settle(request_id: number, result: unknown, error?: string): boolean {
    const waiter = this.waiters.get(request_id)
    if (!waiter) return false
    clearTimeout(waiter.timer)
    this.waiters.delete(request_id)
    if (error) waiter.reject(new Error(error))
    else waiter.resolve(result)
    return true
  }

  get size(): number {
    return this.waiters.size
  }
}
