/**
 * A sandbox in memory for db tests (SANDBOX_PROVIDER=fake): computers are names in a map,
 * commands answer through `exec`, and every stream is a set of pipes the test drives.
 */

import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  getAdapter,
  registerAdapter,
  type ExecResult,
  type SandboxClient,
  type SandboxStream,
} from '@greenhouse/providers';

export interface FakeStream extends SandboxStream {
  /** Pipes the test writes to as the process would. */
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly errors: PassThrough;
  kind: 'screen' | 'stream' | 'devtools';
  name: string;
  argv: string[];
  cwd: string | undefined;
  /** Everything the API wrote to it. */
  written(): Buffer;
  /** Ends it as its process would, with this code. */
  exit(code: number | null): void;
}

type ExecInput = Parameters<SandboxClient['exec']>[1];

export const fake = {
  computers: new Map<string, 'running' | 'stopped'>(),
  streams: [] as FakeStream[],
  /** Answers commands; nothing to say by default. */
  exec: (_name: string, _input: ExecInput): ExecResult | Promise<ExecResult> => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
  }),
  /** Plays a stream's process (a file script); a stream exits 0 when its input ends by default. */
  onStream: (_stream: FakeStream): void => undefined,
  reset() {
    this.computers.clear();
    this.streams = [];
    this.exec = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    this.onStream = () => undefined;
  },
};

export function fakeStream(kind: FakeStream['kind'], name: string, argv: string[], cwd?: string): FakeStream {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks: Buffer[] = [];
  let ended = false;
  let resolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((done) => (resolve = done));
  const exit = (code: number | null) => {
    if (ended) return;
    ended = true;
    output.end();
    errors.end();
    setImmediate(() => resolve(code));
  };
  input.on('data', (chunk: Buffer) => chunks.push(chunk));
  // gh-term and the screen tunnel both end once their input does.
  input.on('end', () => setTimeout(() => exit(0), 5));
  return {
    kind,
    name,
    argv,
    cwd,
    input,
    output,
    errors,
    exited,
    kill: () => exit(null),
    exit,
    written: () => Buffer.concat(chunks),
  };
}

const client: SandboxClient = {
  async ensure(spec) {
    fake.computers.set(spec.name, 'running');
  },
  async status(name) {
    return fake.computers.get(name) ?? 'missing';
  },
  async exec(name, input) {
    return fake.exec(name, input);
  },
  stream(name, input) {
    const stream = fakeStream('stream', name, input.argv, input.cwd);
    fake.streams.push(stream);
    fake.onStream(stream);
    return stream;
  },
  screen(name) {
    const stream = fakeStream('screen', name, []);
    fake.streams.push(stream);
    fake.onStream(stream);
    return stream;
  },
  devtools(name) {
    const stream = fakeStream('devtools', name, []);
    fake.streams.push(stream);
    fake.onStream(stream);
    return stream;
  },
  async stop(name) {
    fake.computers.set(name, 'stopped');
  },
  async restart(name) {
    fake.computers.set(name, 'running');
  },
  async remove(name) {
    fake.computers.delete(name);
  },
};

/** Registers the fake sandbox (once per process) and gives the env that selects it. */
export function fakeSandboxEnv(): Record<string, string> {
  if (!getAdapter('sandbox', 'fake')) {
    registerAdapter({
      capability: 'sandbox',
      kind: 'fake',
      label: 'Fake',
      configSchema: z.object({}).passthrough(),
      secretKeys: [],
      endpoints: () => null,
      create: () => client,
    });
  }
  fake.reset();
  return { SANDBOX_PROVIDER: 'fake' };
}
