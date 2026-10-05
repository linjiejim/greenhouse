/**
 * Lifecycle hooks between the runtime (lower layer: lifecycle, loops) and the
 * modules built on it (access: cached DevTools connections; viewer: live
 * sockets; lease: take-over). The upper modules register here when they load,
 * so runtime.ts never imports them and the dependency direction stays one-way.
 */

type StoppedListener = (userId: string, reason: string) => void;
type UserListener = (userId: string) => void;
type AsyncTask = () => Promise<void>;

const stoppedListeners: StoppedListener[] = [];
const purgedListeners: UserListener[] = [];
const leaseTasks: AsyncTask[] = [];
const shutdownTasks: AsyncTask[] = [];

export const computerLifecycleHooks = {
  onStopped(listener: StoppedListener): void {
    stoppedListeners.push(listener);
  },
  onPurged(listener: UserListener): void {
    purgedListeners.push(listener);
  },
  /** Runs every 30 s while the runtime is ready (auto-release of abandoned take-overs). */
  onLeaseTick(task: AsyncTask): void {
    leaseTasks.push(task);
  },
  onShutdown(task: AsyncTask): void {
    shutdownTasks.push(task);
  },

  stopped(userId: string, reason: string): void {
    for (const listener of stoppedListeners) listener(userId, reason);
  },
  purged(userId: string): void {
    for (const listener of purgedListeners) listener(userId);
  },
  async leaseTick(): Promise<void> {
    for (const task of leaseTasks) await task();
  },
  async shutdown(): Promise<void> {
    await Promise.allSettled(shutdownTasks.map((task) => task()));
  },
};
