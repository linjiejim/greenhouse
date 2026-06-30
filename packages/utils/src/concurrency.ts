/**
 * Shared concurrency utilities.
 */

/**
 * Run an async function over an array of items with bounded concurrency.
 * Individual item errors are caught by `fn` — this function always resolves.
 * If `signal` is provided and aborted, no new tasks are started; resolves once in-flight tasks finish.
 */
export function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let index = 0;
    let active = 0;
    let done = 0;

    function finish() {
      if (active === 0) resolve();
    }

    function next() {
      // Stop scheduling new tasks when aborted
      if (signal?.aborted) {
        finish();
        return;
      }

      while (active < limit && index < items.length) {
        if (signal?.aborted) break;
        const i = index++;
        active++;
        Promise.resolve()
          .then(() => fn(items[i]))
          .then(() => {
            active--;
            done++;
            if (done === items.length || (signal?.aborted && active === 0)) resolve();
            else next();
          })
          .catch(() => {
            active--;
            done++;
            // Don't reject on individual failures — they're caught in the fn
            if (done === items.length || (signal?.aborted && active === 0)) resolve();
            else next();
          });
      }
    }
    next();
  });
}
