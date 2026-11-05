/** One shared hashing worker; files are fingerprinted one at a time, in queue order. */
let worker: Worker | null = null;
let next = 0;
const waiting = new Map<
  number,
  { resolve: (hex: string) => void; reject: (error: Error) => void; progress?: (fraction: number) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ id: number; hex?: string; progress?: number; error?: string }>) => {
    const job = waiting.get(event.data.id);
    if (!job) return;
    if (event.data.progress !== undefined) return job.progress?.(event.data.progress);
    waiting.delete(event.data.id);
    if (event.data.hex) job.resolve(event.data.hex);
    else job.reject(new Error(event.data.error ?? 'hashing failed'));
  };
  return worker;
}

export function sha256File(file: File, progress?: (fraction: number) => void): Promise<string> {
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, progress });
    getWorker().postMessage({ id, file });
  });
}
