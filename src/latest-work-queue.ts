/** One active writer; a newer request supersedes queued work and fences active work. */
export class LatestWorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  invalidate(): void { this.generation += 1; }

  run(work: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation;
    const result = this.tail.catch(() => undefined).then(async () => {
      if (isCurrent()) await work(isCurrent);
    });
    this.tail = result;
    return result;
  }
}
