/**
 * Computer lifecycle concurrency on real PostgreSQL: two controllers stand in
 * for the two blue/green API slots sharing one database and one Docker daemon.
 *
 * @db-commit-reason The per-member and capacity advisory locks and the
 * version CAS only exclude each other across independently committed
 * connections; a rollback-wrapped single connection would re-enter its own
 * locks and prove nothing.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import type { BotsComputerConfig } from './config.js';
import { createComputerController, type Clock, type ControllerEnvironment } from './controller.js';
import { createDockerHost } from './docker-host.js';
import type { ContainerSummary, DockerClient, DockerSpawnResult } from './docker.js';
import { ComputerUnavailableError } from './errors.js';

let db: DatabaseProvider;
const userIds: string[] = [];

const config: BotsComputerConfig = {
  driver: 'docker',
  e2b: null,
  image: 'greenhouse/bot-computer:latest',
  runtime: 'runc',
  hardened: false,
  network: 'gh-bots-test',
  networkManaged: true,
  memory: '2g',
  memoryBytes: 2 * 1024 ** 3,
  cpus: '1.5',
  proxy: null,
  namespace: 'capacity',
  timezone: 'UTC',
  lang: null,
  jobMaxHours: 8,
  missionNetwork: 'cloud-agent',
};

/** Virtual time that never really waits, so the 45 s queue finishes in milliseconds. */
function fastClock(): Clock {
  let elapsed = 0;
  const base = Date.now();
  return {
    now: () => base + elapsed,
    sleep: async (ms) => {
      elapsed += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** One shared daemon: records how many computers were claimed at every `docker run`. */
function sharedDocker() {
  const containers = new Set<string>();
  const runs: string[] = [];
  let maxClaimed = 0;
  const ok = (stdout = ''): DockerSpawnResult => ({
    code: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: '',
    stdoutTruncated: false,
    timedOut: false,
    aborted: false,
  });
  const client = {
    volumeCreate: async () => {},
    remove: async (name: string) => {
      containers.delete(name);
    },
    stop: async () => {},
    run: async (args: string[]) => {
      const name = args[args.indexOf('--name') + 1]!;
      const claimed = (await db.botComputers.listByStates(['starting', 'running'])).filter(
        (r) => r.namespace === config.namespace,
      ).length;
      maxClaimed = Math.max(maxClaimed, claimed);
      runs.push(name);
      // Widen the race window between the two "slots".
      await new Promise((resolve) => setTimeout(resolve, 25));
      containers.add(name);
      return `id-${name}`;
    },
    exec: async () => ok(JSON.stringify({ id: 1, result: { product: 'Chrome/154' } })),
    ps: async (): Promise<ContainerSummary[]> => [],
  } as unknown as DockerClient;
  return { client, runs, maxClaimed: () => maxClaimed };
}

function controllerFor(docker: DockerClient, maxRunning: number) {
  const env: ControllerEnvironment = { config, maxRunning, idleMinutes: 15, urlBlocklist: [], imageId: null };
  return createComputerController({
    store: db.botComputers,
    host: createDockerHost(docker),
    environment: async () => env,
    userIsActive: async () => true,
    clock: fastClock(),
  });
}

async function seedUser(): Promise<string> {
  const user = await db.users.create({
    email: `bots-capacity-${randomUUID()}@test.local`,
    password_hash: 'x',
    nickname: 'Capacity',
    role: 'team',
  });
  userIds.push(user.id);
  return user.id;
}

describe('computer lifecycle across two API slots (real PostgreSQL)', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    // bot_computers rows cascade with their member.
    for (const id of userIds.splice(0)) await db.users.delete(id);
    await db.close();
    _resetProvider();
  });

  it('never exceeds capacity when members start concurrently from both slots', async () => {
    const docker = sharedDocker();
    const blue = controllerFor(docker.client, 2);
    const green = controllerFor(docker.client, 2);
    const users = await Promise.all(Array.from({ length: 5 }, () => seedUser()));

    const outcomes = await Promise.allSettled(
      users.map((userId, i) => (i % 2 === 0 ? blue : green).ensureRunning(userId)),
    );

    const started = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(started).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const outcome of refused) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(ComputerUnavailableError);
      expect(reason.code).toBe('busy');
    }
    expect(docker.maxClaimed()).toBeLessThanOrEqual(2);
    expect(docker.runs).toHaveLength(2);
    const running = (await db.botComputers.listByStates(['starting', 'running'])).filter((r) =>
      users.includes(r.user_id),
    );
    expect(running).toHaveLength(2);
  });

  it('starts one member exactly once when both slots ask at the same time', async () => {
    const docker = sharedDocker();
    const blue = controllerFor(docker.client, 5);
    const green = controllerFor(docker.client, 5);
    const userId = await seedUser();

    const [a, b, c] = await Promise.all([
      blue.ensureRunning(userId),
      green.ensureRunning(userId),
      blue.ensureRunning(userId),
    ]);

    expect(docker.runs).toHaveLength(1);
    expect([a.state, b.state, c.state]).toEqual(['running', 'running', 'running']);
    expect(a.version).toBe(b.version);
  });

  it('lets exactly one of two concurrent transitions and lease changes win', async () => {
    const userId = await seedUser();
    const row = await db.botComputers.ensure({
      user_id: userId,
      namespace: config.namespace,
      container_name: `gh-computer-capacity-${userId}`,
      volume_name: `gh-computer-capacity-${userId}-home`,
    });

    const transitions = await Promise.all([
      db.botComputers.transition(userId, row.version, ['absent'], { state: 'starting' }),
      db.botComputers.transition(userId, row.version, ['absent'], { state: 'starting' }),
    ]);
    expect(transitions.filter(Boolean)).toHaveLength(1);

    const leases = await Promise.all([
      db.botComputers.setLease(userId, 'user'),
      db.botComputers.setLease(userId, 'user'),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect((await db.botComputers.get(userId))?.lease_epoch).toBe(row.lease_epoch + 1);
  });
});
