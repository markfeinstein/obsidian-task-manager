/** Run independent Dashboard card work with a fixed concurrency ceiling. */
export async function runDashboardRenderQueue<T>(
  items: readonly T[],
  concurrency: number,
  render: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const limit = Math.max(1, Math.min(items.length || 1, Math.floor(concurrency)));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (shouldContinue()) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await render(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
}
