/**
 * One queue per key: writes to the same conversation run one at a time in this process. Across
 * processes the conversation row lock does the same; this keeps a process from contending with
 * itself, and keeps tests (one shared transaction) in order.
 */
export function createKeyedLock() {
  const tails = new Map<string, Promise<void>>();
  return async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
