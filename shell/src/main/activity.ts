// What openMoi is busy with right now: the side panel shows each running task with how long it has taken.
import type { Activity } from "../shared/types"

export type Track = <T>(label: string, work: () => Promise<T>) => Promise<T>

export class ActivityTracker {
  private activities: Activity[] = []
  private next_id = 1

  constructor(private readonly changed: () => void) {}

  list(): Activity[] {
    return this.activities
  }

  // The label shows while work runs and goes away however it ends.
  async track<T>(label: string, work: () => Promise<T>): Promise<T> {
    const activity = { activity_id: this.next_id++, label, started_at: Date.now() }
    this.activities = [...this.activities, activity]
    this.changed()
    try {
      return await work()
    } finally {
      this.activities = this.activities.filter((each) => each !== activity)
      this.changed()
    }
  }
}
