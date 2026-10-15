/** Process-local timers must end before the app releases its database. */
export function createTimerScope() {
  const timers = new Set<NodeJS.Timeout>();
  let disposed = false;
  const track = (timer: NodeJS.Timeout) => {
    timer.unref();
    if (disposed) clearTimeout(timer);
    else timers.add(timer);
    return timer;
  };
  return {
    timeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      return track(timer);
    },
    interval(callback: () => void, delay: number) {
      const timer = setInterval(callback, delay);
      return track(timer);
    },
    clear(timer: NodeJS.Timeout | null | undefined) {
      if (!timer) return;
      clearTimeout(timer);
      timers.delete(timer);
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
