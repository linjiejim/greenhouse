/**
 * Agent computers on the local Docker engine, through the docker CLI. Each computer is one
 * container with a named volume on /home, so a restart or a new image keeps the Agent's files.
 *
 * Hardening (always): read-only root, every capability dropped, no new privileges, bounded
 * pids, memory, swap, tmp and logs, no published port. Production uses the gVisor runtime
 * (`runsc`); `runc` is for development machines without it.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ExecResult, ProviderAdapter, SandboxClient, SandboxSpec } from '../types.js';

export const dockerConfigSchema = z.object({
  image: z.string().min(1).max(200).default('greenhouse/computer:latest'),
  runtime: z.enum(['runsc', 'runc']).default('runsc'),
  network: z.string().min(1).max(100).default('bridge'),
  memory: z
    .string()
    .regex(/^\d+[kmg]$/i)
    .default('2g'),
  cpus: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('2'),
});
export type DockerConfig = z.infer<typeof dockerConfigSchema>;

const DEFAULT_OUTPUT_CAP = 1024 * 1024;
const CONTROL_TIMEOUT_MS = 120_000;
const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export const volumeOf = (name: string) => `${name}-home`;

export class DockerError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

/** Runs the docker CLI with a deadline and capped output. */
export function runDocker(
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ExecResult> {
  const cap = options.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? CONTROL_TIMEOUT_MS);
    child.stdout.on('data', (data: Buffer) => {
      if (outBytes < cap) out.push(data.subarray(0, cap - outBytes));
      outBytes += data.length;
    });
    child.stderr.on('data', (data: Buffer) => {
      if (errBytes < cap) err.push(data.subarray(0, cap - errBytes));
      errBytes += data.length;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DockerError(`The docker command could not run: ${error.message}`, -1));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });
  });
}

async function control(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new DockerError(
      `docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      result.exitCode,
    );
  }
  return result.stdout.trim();
}

/** The exact `docker run` arguments of a computer; pure, so a test pins every hardening flag. */
export function runArgs(config: DockerConfig, spec: SandboxSpec): string[] {
  const args = ['run', '-d', '--name', spec.name];
  for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`);
  args.push(
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    config.memory,
    '--memory-swap',
    config.memory,
    '--cpus',
    config.cpus,
    '--shm-size',
    '1g',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=1g',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--network',
    config.network,
    '--runtime',
    config.runtime,
    '-v',
    `${volumeOf(spec.name)}:/home`,
    '-e',
    `TZ=${spec.timezone}`,
    // Never inherit a developer's proxy into the computer.
    ...[
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'NO_PROXY',
      'no_proxy',
      'ALL_PROXY',
      'all_proxy',
    ].flatMap((variable) => ['-e', `${variable}=`]),
    config.image,
  );
  return args;
}

export function createDockerSandbox(config: DockerConfig): SandboxClient {
  const checkName = (name: string) => {
    if (!NAME.test(name)) throw new DockerError(`Invalid computer name "${name}"`, -1);
    return name;
  };
  const client: SandboxClient = {
    async status(name) {
      const result = await runDocker(['inspect', '--format', '{{.State.Running}}', checkName(name)]);
      if (result.exitCode !== 0) return 'missing';
      return result.stdout.trim() === 'true' ? 'running' : 'stopped';
    },
    async ensure(spec) {
      const state = await client.status(spec.name);
      if (state === 'running') return;
      if (state === 'stopped') {
        await control(['start', spec.name]);
        return;
      }
      await control(runArgs(config, spec));
    },
    async exec(name, input) {
      const args = [
        'exec',
        '-u',
        input.user,
        '-w',
        input.cwd ?? (input.user === 'agent' ? '/home/agent' : '/'),
        checkName(name),
        ...input.argv,
      ];
      const result = await runDocker(args, { timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes });
      return result;
    },
    async stop(name) {
      if ((await client.status(name)) === 'running') await control(['stop', '--time', '10', checkName(name)]);
    },
    async restart(name) {
      await control(['restart', '--time', '10', checkName(name)]);
    },
    async remove(name, options) {
      await runDocker(['rm', '-f', checkName(name)]);
      if (!options.keepHome) await runDocker(['volume', 'rm', '-f', volumeOf(name)]);
    },
  };
  return client;
}

export const dockerAdapter: ProviderAdapter<'sandbox', DockerConfig> = {
  capability: 'sandbox',
  kind: 'docker',
  label: 'Docker',
  configSchema: dockerConfigSchema as z.ZodType<DockerConfig>,
  secretKeys: [],
  // The engine is local: no credential ever leaves the machine.
  endpoints: () => null,
  create: ({ config }) => createDockerSandbox(config),
  async test(_client, config) {
    await control(['version', '--format', '{{.Server.Version}}']);
    const runtimes = await control(['info', '--format', '{{json .Runtimes}}']);
    if (!JSON.parse(runtimes || '{}')[config.runtime]) {
      throw new DockerError(`Docker has no "${config.runtime}" runtime here.`, -1);
    }
    await control(['image', 'inspect', '--format', '{{.Id}}', config.image]);
  },
};
