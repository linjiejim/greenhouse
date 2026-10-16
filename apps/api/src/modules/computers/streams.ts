/** File transfers over a computer's streams: an upload runs to its end, a download streams out. */

import type { SandboxStream } from '@greenhouse/providers';

const STDERR_CHARS = 4096;

/** Writes `input` (or nothing) to a stream, waits for it to end, and returns what it said. */
export async function runToEnd(
  stream: SandboxStream,
  input: Uint8Array | null,
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const out: Buffer[] = [];
  let outBytes = 0;
  let stderr = '';
  stream.output.on('data', (chunk: Buffer) => {
    if (outBytes < options.maxOutputBytes) out.push(chunk.subarray(0, options.maxOutputBytes - outBytes));
    outBytes += chunk.length;
  });
  stream.errors.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_CHARS) stderr += chunk.toString('utf8');
  });
  // A broken pipe shows up as the exit code; never as an unhandled error.
  stream.output.on('error', () => undefined);
  stream.errors.on('error', () => undefined);
  const timer = setTimeout(() => stream.kill(), options.timeoutMs);
  if (input) stream.input.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  else stream.input.end();
  try {
    const code = await stream.exited;
    return { code, stdout: Buffer.concat(out).toString('utf8'), stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first line a download writes, its size, with whatever bytes came after it; or how the
 * stream ended when it ended first. Leaves the output paused for the body.
 */
export function readSizeLine(
  stream: SandboxStream,
): Promise<{ size: number; rest: Buffer } | { code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const finish = (value: { size: number; rest: Buffer } | { code: number | null; stderr: string }) => {
      if (settled) return;
      settled = true;
      stream.output.off('data', onData);
      stream.output.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf(0x0a);
      if (newline < 0) {
        if (head.length > 32) finish({ code: null, stderr: 'The computer answered something unexpected.' });
        return;
      }
      const size = Number(head.subarray(0, newline).toString('latin1'));
      finish(
        Number.isSafeInteger(size) && size >= 0
          ? { size, rest: head.subarray(newline + 1) }
          : { code: null, stderr: 'The computer answered something unexpected.' },
      );
    };
    stream.errors.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CHARS) stderr += chunk.toString('utf8');
    });
    stream.output.on('data', onData);
    stream.output.on('error', () => finish({ code: null, stderr }));
    stream.errors.on('error', () => undefined);
    // The process ends after its output and errors have been read, so `stderr` is whole here.
    void stream.exited.then((code) => finish({ code, stderr }));
  });
}

/**
 * Exactly `size` bytes of a download as a web stream: a file that shrinks on the way fails the
 * download instead of cutting it short quietly, and a reader that goes away ends the transfer.
 */
export function bodyOf(
  stream: SandboxStream,
  size: number,
  first: Buffer,
  onProgress: () => void,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let done = false;
  let reportedAt = Date.now();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const end = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) controller.error(error);
        else controller.close();
      };
      const push = (chunk: Buffer) => {
        if (done) return;
        const part = chunk.subarray(0, size - sent);
        if (part.length) {
          controller.enqueue(new Uint8Array(part));
          sent += part.length;
        }
        // A long transfer is activity: the idle stop never cuts one off.
        if (Date.now() - reportedAt > 60_000) {
          reportedAt = Date.now();
          onProgress();
        }
        if ((controller.desiredSize ?? 1) <= 0) stream.output.pause();
      };
      if (first.length) push(first);
      stream.output.on('data', push);
      stream.output.on('error', (error: Error) => end(error));
      stream.output.on('end', () =>
        end(sent === size ? undefined : new Error(`The download stopped after ${sent} of ${size} bytes.`)),
      );
      stream.output.resume();
    },
    pull() {
      stream.output.resume();
    },
    cancel() {
      done = true;
      stream.kill();
    },
  });
}
