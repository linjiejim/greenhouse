/**
 * The docker host (host.ts): a member's computer is a container on the API's
 * own Docker daemon, its home a named volume.
 *
 * - The container is stateless: a stop removes it and every start is a fresh
 *   `docker run` with the CURRENT argv (buildComputerRunArgs), so image, knob
 *   and hardening changes reach everyone on their next start.
 * - Everything inside is reached through `docker exec` — VNC and DevTools are
 *   0600 Unix sockets tunnelled with socat as uid `browser`; the container
 *   publishes no port.
 * - All homes share the daemon's disk (`sharedDisk`): the controller guards it.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { BotsComputerConfig } from './config.js';
import { buildComputerRunArgs, buildHomeHelperArgs, type DockerClient } from './docker.js';
import { HOME_USERS, homeExportArgv, homeImportArgv, pipeIntoImport } from './home-archive.js';
import {
  ComputerStartError,
  type ComputerHost,
  type ComputerTunnel,
  type HomeRestore,
  type HostInstance,
} from './host.js';
import { computerLabels, LABEL_USER, namespaceFilter } from './namespace.js';

/** `docker stop -t` — gh-computer closes the browser first, so its profile reaches the volume. */
const STOP_TIMEOUT_SEC = 5;
/** Orphan volumes (no row) are kept this long after creation, in case a row is still being written. */
export const VOLUME_GRACE_MS = 24 * 60 * 60_000;
/** Putting both homes back from a backup (a helper container per uid); the start holds the member's lock. */
const RESTORE_TIMEOUT_MS = 15 * 60_000;

const TUNNEL_ARGV: Record<ComputerTunnel, string[]> = {
  vnc: ['socat', 'STDIO', 'UNIX-CONNECT:/tmp/browser/vnc.sock'],
  cdp: ['socat', 'STDIO', 'UNIX-CONNECT:/tmp/browser/cdp.sock'],
};

export function createDockerHost(docker: DockerClient, opts: { now?: () => number } = {}): ComputerHost {
  const now = opts.now ?? Date.now;

  /** Fill a new home volume from a backup, one helper container per uid (docker.ts buildHomeHelperArgs). */
  async function restoreVolume(volume: string, source: HomeRestore, config: BotsComputerConfig): Promise<void> {
    const deadline = now() + RESTORE_TIMEOUT_MS;
    for (const user of HOME_USERS) {
      const data = await source.open(user);
      const helper = docker.runStream(
        buildHomeHelperArgs({ image: config.image, volume, runtime: config.runtime, user }, homeImportArgv(user)),
      );
      await pipeIntoImport(data, helper, Math.max(1, deadline - now()));
    }
  }

  return {
    kind: 'docker',
    sharedDisk: true,

    exec: (spec) => docker.exec(spec),
    execStream: (container, user, argv, streamOpts) => docker.execStream(container, user, argv, streamOpts),
    openTunnel: (container, target) => docker.execStream(container, 'browser', TUNNEL_ARGV[target]),
    openPort: (container, port) => docker.execStream(container, 'agent', ['socat', 'STDIO', `TCP:127.0.0.1:${port}`]),

    exportHome: (ref, user) => docker.execStream(ref, user, homeExportArgv(user)),

    async start(row, spec) {
      const { config } = spec;
      // No home volume although the member had a computer (another driver before): make it from the newest backup.
      const restoreFrom = spec.restore && !(await docker.volumeExists(row.volume_name)) ? await spec.restore() : null;
      await docker.volumeCreate(row.volume_name, computerLabels(config.namespace, row.user_id));
      if (restoreFrom) {
        const startedAt = now();
        try {
          await restoreVolume(row.volume_name, restoreFrom, config);
        } catch (err) {
          // A half-filled home is no home: the next start finds no volume and restores again.
          await docker.volumeRemove(row.volume_name).catch(() => {});
          throw new ComputerStartError(
            'restore_failed',
            `Restoring the backup of ${restoreFrom.takenAt} failed: ${toErrorMessage(err)}`,
            { cause: err },
          );
        }
        logger.info('[bots-computer] restored a home from its backup', {
          user_id: row.user_id,
          backup: restoreFrom.backupId,
          volume: row.volume_name,
          duration_ms: now() - startedAt,
        });
      }
      // A container left behind by an earlier failure would hold the name.
      await docker.remove(row.container_name);
      await docker.run(
        buildComputerRunArgs({
          name: row.container_name,
          namespace: config.namespace,
          userId: row.user_id,
          image: config.image,
          volume: row.volume_name,
          network: config.network,
          runtime: config.runtime,
          memory: config.memory,
          cpus: config.cpus,
          proxy: config.proxy,
          urlBlocklist: spec.urlBlocklist,
          timezone: spec.timezone,
          lang: spec.lang,
        }),
      );
      return {
        ref: row.container_name,
        imageId: spec.image,
        ...(restoreFrom ? { restoredFrom: restoreFrom.backupId } : {}),
        abandon: () => docker.remove(row.container_name),
      };
    },

    async stop(ref) {
      try {
        await docker.stop(ref, STOP_TIMEOUT_SEC);
      } finally {
        // Removed even when the stop failed: a container that would not stop is no better kept.
        await docker.remove(ref);
      }
    },

    discard: (ref) => docker.remove(ref),

    async wipe(row) {
      // The volume can only go once its container has.
      await docker.remove(row.container_name);
      await docker.volumeRemove(row.volume_name);
    },

    async list(namespace) {
      return (await docker.ps(namespaceFilter(namespace))).map(
        (container): HostInstance => ({
          ref: container.name,
          userId: container.labels[LABEL_USER] ?? '',
          running: container.state === 'running',
        }),
      );
    },

    async inspect(ref) {
      const state = await docker.inspectState(ref);
      return state ? { running: state.running } : null;
    },

    async verdict(ref, instance) {
      if (!instance) return { state: 'error', reason: 'exited' };
      const state = await docker.inspectState(ref);
      // gVisor kills the whole sandbox on OOM, which can surface as a plain 137.
      return { state: 'error', reason: state?.oomKilled || state?.exitCode === 137 ? 'oom' : 'exited' };
    },

    async removeOrphan(instance) {
      await docker.remove(instance.ref);
      return true;
    },

    async sweepStorage(namespace, owner) {
      let removed = 0;
      for (const volume of await docker.volumeList(namespaceFilter(namespace))) {
        const userId = volume.labels[LABEL_USER] ?? '';
        if ((await owner(userId))?.volume_name === volume.name) continue;
        const createdAt = await docker.volumeCreatedAt(volume.name);
        if (!createdAt || now() - Date.parse(createdAt) < VOLUME_GRACE_MS) continue;
        // A row created meanwhile (a member's first start) owns it now.
        if ((await owner(userId))?.volume_name === volume.name) continue;
        try {
          await docker.volumeRemove(volume.name);
          removed++;
        } catch (err) {
          logger.warn(`[bots-computer] could not remove orphan volume ${volume.name}: ${toErrorMessage(err)}`);
        }
      }
      return removed;
    },

    memoryUsage: (refs) => docker.memoryUsage(refs),
  };
}
