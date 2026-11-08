// Stands in for the status line in tests: runs the work and remembers each label it was shown under.
export class Tracked {
  readonly labels: string[] = []

  readonly track = <T>(label: string, work: () => Promise<T>): Promise<T> => {
    this.labels.push(label)
    return work()
  }
}
