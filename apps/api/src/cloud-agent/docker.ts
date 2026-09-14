/**
 * Docker CLI wrapper for the Mission Sandbox Runner controller.
 *
 * Deliberately shells out to the `docker` binary (execFile, no shell
 * interpolation) instead of adding a daemon-API dependency: the controller
 * needs exactly run / inspect / rm / ps, streams stay HTTP-side (the runner
 * pushes events to /api/missions/internal/*, we never attach). The
 * interface is narrow so tests inject a fake.
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 15_000;

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export type DockerCommand = (
  executable: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<DockerCommandResult>;

const runDockerCommand: DockerCommand = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, {
    ...options,
    timeout: options?.timeout ?? DOCKER_COMMAND_TIMEOUT_MS,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export class DockerControlPlaneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerControlPlaneError';
  }
}

export const RUN_LABEL = 'greenhouse.cloud-agent.run';
const CONTAINER_PREFIX = 'greenhouse-cloud-agent-';

export interface ContainerState {
  running: boolean;
  exitCode: number;
}

export interface AgentContainer {
  id: string;
  name: string;
  runId: string;
}

export interface StartContainerSpec {
  runId: string;
  image: string;
  network: string;
  memory: string;
  cpus: string;
  /** `docker run --runtime` override (e.g. 'runsc'); omitted = daemon default. */
  runtime?: string | null;
  /** host path → container path (all rw except `readonly: true`). */
  mounts: Array<{ host: string; container: string; readonly?: boolean }>;
  env: Record<string, string>;
}

export function containerNameFor(runId: string): string {
  return `${CONTAINER_PREFIX}${runId}`;
}

/**
 * Exact hardened `docker run` argv. Kept pure so CI can prove that production
 * cannot silently lose read-only rootfs, tmpfs, capability or runtime flags.
 */
export function buildDockerRunArgs(spec: StartContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    containerNameFor(spec.runId),
    '--label',
    `${RUN_LABEL}=${spec.runId}`,
    '--memory',
    spec.memory,
    '--cpus',
    spec.cpus,
    '--pids-limit',
    '512',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs',
    '/home/agent:rw,nosuid,nodev,size=64m',
    '--network',
    spec.network,
    // Lets the sandbox reach the api via a stable name on Linux hosts.
    '--add-host',
    'host.docker.internal:host-gateway',
  ];
  if (spec.runtime) args.push('--runtime', spec.runtime);
  for (const mount of spec.mounts) {
    args.push('-v', `${mount.host}:${mount.container}${mount.readonly ? ':ro' : ''}`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(spec.image);
  return args;
}

/** Narrow surface consumed by the controller; tests substitute a fake. */
export interface DockerCli {
  validateEnvironment?(spec: {
    image: string;
    network: string;
    runtime: string | null;
    requireEgressPolicy?: boolean;
    apiPort?: number;
  }): Promise<void>;
  startContainer(spec: StartContainerSpec): Promise<string>;
  inspectContainer(nameOrId: string): Promise<ContainerState | null>;
  removeContainer(nameOrId: string): Promise<void>;
  listAgentContainers(): Promise<AgentContainer[]>;
  tailLogs(nameOrId: string, lines: number): Promise<string>;
}

/**
 * The docker executable itself is absent (`spawn docker ENOENT`), as in a
 * container image without a docker CLI. Nothing on this host can be reached
 * through it, so retrying the same call can never change the answer.
 */
export function isDockerExecutableMissing(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === 'ENOENT') return true;
    current = e.cause;
  }
  return false;
}

export function isMissingContainerError(err: unknown): boolean {
  const message = toErrorMessage(err);
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr ?? '') : '';
  return /No such container/i.test(`${message}\n${stderr}`);
}

export function createDockerCli(command: DockerCommand = runDockerCommand): DockerCli {
  return {
    async validateEnvironment(spec): Promise<void> {
      try {
        await command('docker', ['info', '--format', '{{json .Runtimes}}']);
      } catch (err) {
        throw new Error(`Docker daemon is unavailable: ${toErrorMessage(err)}`);
      }
      try {
        await command('docker', ['image', 'inspect', spec.image]);
      } catch {
        throw new Error(`Sandbox Runner image is missing: ${spec.image}`);
      }
      try {
        const { stdout } = await command('docker', ['network', 'inspect', spec.network, '--format', '{{json .}}']);
        const network = JSON.parse(stdout) as {
          EnableIPv6?: unknown;
          Options?: Record<string, unknown> | null;
        };
        if (network.EnableIPv6 !== false) {
          throw new Error(`Sandbox network must have IPv6 disabled: ${spec.network}`);
        }
        if (network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') {
          throw new Error(`Sandbox network must disable inter-container communication: ${spec.network}`);
        }
      } catch {
        throw new Error(
          `Mission Docker network is missing or unsafe: ${spec.network} (require IPv6=false and enable_icc=false)`,
        );
      }
      if (spec.runtime) {
        const { stdout } = await command('docker', ['info', '--format', '{{json .Runtimes}}']);
        let runtimes: Record<string, unknown>;
        try {
          runtimes = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          throw new Error('Docker returned an unreadable runtime list');
        }
        if (!(spec.runtime in runtimes)) throw new Error(`Docker runtime is unavailable: ${spec.runtime}`);
      }
      if (spec.requireEgressPolicy) {
        const script = fileURLToPath(new URL('../../../../scripts/cloud-agent-net.sh', import.meta.url));
        try {
          await command('bash', [script, '--check'], {
            env: {
              ...process.env,
              SANDBOX_RUNNER_NETWORK: spec.network,
              ...(spec.apiPort ? { API_PORT: String(spec.apiPort) } : {}),
            },
          });
        } catch (err) {
          throw new Error(`Sandbox egress policy is unavailable: ${toErrorMessage(err)}`);
        }
      }
    },
    async startContainer(spec: StartContainerSpec): Promise<string> {
      try {
        const { stdout } = await command('docker', buildDockerRunArgs(spec));
        return stdout.trim();
      } catch (err) {
        throw new DockerControlPlaneError(`Failed to start sandbox container: ${toErrorMessage(err)}`, {
          cause: err,
        });
      }
    },

    async inspectContainer(nameOrId: string): Promise<ContainerState | null> {
      try {
        const { stdout } = await command('docker', [
          'inspect',
          '--format',
          '{{.State.Running}} {{.State.ExitCode}}',
          nameOrId,
        ]);
        const [running, exitCode] = stdout.trim().split(' ');
        return { running: running === 'true', exitCode: Number(exitCode ?? 0) };
      } catch (err) {
        if (isMissingContainerError(err)) return null;
        throw new DockerControlPlaneError(`Failed to inspect sandbox container ${nameOrId}: ${toErrorMessage(err)}`, {
          cause: err,
        });
      }
    },

    async removeContainer(nameOrId: string): Promise<void> {
      try {
        await command('docker', ['rm', '-f', nameOrId]);
      } catch (err) {
        if (isMissingContainerError(err)) return;
        throw new DockerControlPlaneError(`Failed to remove sandbox container ${nameOrId}: ${toErrorMessage(err)}`, {
          cause: err,
        });
      }
    },

    async listAgentContainers(): Promise<AgentContainer[]> {
      let stdout: string;
      try {
        ({ stdout } = await command('docker', [
          'ps',
          '-a',
          '--filter',
          `label=${RUN_LABEL}`,
          '--format',
          `{{.ID}}\t{{.Names}}\t{{.Label "${RUN_LABEL}"}}`,
        ]));
      } catch (err) {
        throw new DockerControlPlaneError(`Failed to list sandbox containers: ${toErrorMessage(err)}`, {
          cause: err,
        });
      }
      return stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [id, name, runId] = line.split('\t');
          return { id: id ?? '', name: name ?? '', runId: runId ?? '' };
        })
        .filter((c) => c.runId.length > 0);
    },

    async tailLogs(nameOrId: string, lines: number): Promise<string> {
      try {
        const { stdout, stderr } = await command('docker', ['logs', '--tail', String(lines), nameOrId]);
        return [stdout, stderr].filter(Boolean).join('\n');
      } catch {
        return '';
      }
    },
  };
}
