import { computerServices } from '../services.js';
import { type MemberComputerRow } from '../schema.js';
/**
 * Members' cloud computers on the real database, with a fake E2B driver (no
 * test ever reaches E2B): the workspace switch (no path creates a sandbox while
 * it is off, and the computer tools are not listed over MCP), the lifecycle
 * (created on first use, reused, idle stop, concurrency limit), per-minute
 * billing in blocks (reserve, roll, settle the minutes run) and the
 * unknown-outcome rule (a create or a stop the provider did not confirm keeps
 * its reservation for the budget sweeper).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
// Each case drives the MCP server, recorded writes and metering on the real
// database; under a full parallel run that can pass the default 5 s.
vi.setConfig({ testTimeout: 20000 });
const fakes = vi.hoisted(() => ({
  objects: new Map<
    string,
    {
      buffer: Buffer;
      contentType: string;
    }
  >(),
}));
vi.mock('../../../../apps/api/src/storage/uploads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/api/src/storage/uploads.js')>();
  return {
    ...actual,
    putObjectAtKey: async (key: string, buffer: Buffer, contentType: string) =>
      void fakes.objects.set(key, { buffer, contentType }),
    getObjectAtKey: async (key: string) => fakes.objects.get(key) ?? null,
    deleteObjectAtKey: async (key: string) => void fakes.objects.delete(key),
    listObjectKeys: async () => [...fakes.objects.keys()],
  };
});
import { setComputerDriverForTests, type ComputerDriver } from '../driver.js';
import {
  COMPUTER_DISABLED_MESSAGE,
  ensureComputer,
  rollComputerBlock,
  stopComputer,
  sweepComputers,
  stopMemberComputer,
  withHeartbeat,
} from '../service.js';
import { ProviderRequestError } from '../e2b/http.js';
import { buildMcpServer, composeMcpContext } from '../../../../apps/api/src/routes/mcp.js';
import { identityFromOAuthScopes } from '../../../../apps/api/src/agent-runtime/mcp-auth.js';
import { buildExternalServiceTools } from '../../../../apps/api/src/agent-runtime/service-tools.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../../../../apps/api/src/platform/projects/application.js';
import { knowledgeRegistration } from '../../../../apps/api/src/platform/knowledge/registration.js';
import { tablesRegistration } from '../../../../apps/api/src/platform/tables/application.js';
import { runWithMeteringScope, type MeteringScope } from '../../../../apps/api/src/usage/metering.js';
import { setPriceOverridesForTests, syncPriceOverrides } from '../../../../apps/api/src/usage/pricing.js';
import { uploadCabinetFile } from '../../../../apps/api/src/drive/kb-cabinet.js';
import { delegatedAgentActor } from '../../../../apps/api/src/platform/actor.js';
import { computerRoutes } from '../routes/computer.js';
import { invalidateWorkspaceConfigCache } from '../../../../apps/api/src/settings/workspace-config.js';
import type { AppEnv } from '../../../../apps/api/src/app-env.js';
/** services.yaml: $0.0018 a minute → 1,800 micros; a 15-minute block reserves 27,000. */
const PER_MINUTE = 1800;
const BLOCK = 15 * PER_MINUTE;
const MINUTE = 60000;
let db: DatabaseProvider;
let member: UserRow;
let clientId: string;
let driver: ReturnType<typeof fakeDriver>;
const savedEnv = { ...process.env };
function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function fakeDriver() {
  let next = 0;
  const files = new Map<string, Buffer>();
  const alive = new Set<string>();
  const impl = {
    files,
    alive,
    create: vi.fn(async () => {
      const sandboxId = `sbx_${++next}_${Math.random().toString(36).slice(2, 6)}`;
      alive.add(sandboxId);
      return { sandboxId };
    }),
    exec: vi.fn(
      async (
        _id: string,
        input: {
          command: string;
        },
      ) => ({
        exitCode: 0,
        stdout: `ran: ${input.command}\n`,
        stderr: '',
        timedOut: false,
        stdoutBytes: input.command.length + 6,
        stderrBytes: 0,
      }),
    ),
    readFile: vi.fn(
      async (
        _id: string,
        input: {
          path: string;
        },
      ) => {
        const found = files.get(input.path);
        if (!found) throw new ProviderRequestError('There is no such file in the computer.', 404);
        return found;
      },
    ),
    writeFile: vi.fn(
      async (
        _id: string,
        input: {
          path: string;
          bytes: Buffer;
        },
      ) => void files.set(input.path, input.bytes),
    ),
    renew: vi.fn(async (id: string, _timeoutSeconds?: number) => alive.has(id)),
    kill: vi.fn(async (id: string) => void alive.delete(id)),
  };
  return impl satisfies ComputerDriver & Record<string, unknown>;
}
const scope = (): MeteringScope => ({ userId: member.id, client: 'mcp', oauthClientId: clientId });
async function memberComputer(): Promise<MemberComputerRow> {
  const rows = await computerServices(db).memberComputers.listForUser(member.id, 1);
  return rows[0]!;
}
async function computerFacts() {
  return (await db.executeRaw(sql`SELECT units::int AS units, unit_kind, cost_usd_micros, client, oauth_client_id, run_id FROM usage_events
        WHERE kind = 'service' AND user_id = ${member.id} AND service = 'computer' ORDER BY created_at, id`)) as Array<
    Record<string, unknown>
  >;
}
async function reservations(key: string) {
  return db.usageBudget.getReservationGroup(key);
}
async function connect(scopes: string[]) {
  const identity = identityFromOAuthScopes({ id: member.id, role: 'team' }, scopes);
  const ctx = await composeMcpContext(identity, {});
  const c = {
    get: (key: string) =>
      key === 'agentIdentity'
        ? identity
        : key === 'oauthClientId'
          ? clientId
          : key === 'oauthAuthMethod'
            ? 'oauth'
            : undefined,
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}
type CallResult = {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
};
function tools() {
  return buildExternalServiceTools(db, ['computer_exec', 'computer_files', 'computer_transfer', 'computer_stop'], {
    userId: member.id,
  }) as Record<
    string,
    {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    }
  >;
}
/** The workspace switch `computer.enabled`, stored like an admin would (inside the test transaction). */
async function setSwitch(on: boolean) {
  await db.workspaceSettings.set('computer.enabled', { value: on }, member.id);
  invalidateWorkspaceConfigCache();
}
function run(toolId: string, input: Record<string, unknown>) {
  return runWithMeteringScope(scope(), () => tools()[toolId]!.execute(input, { toolCallId: 't', messages: [] }));
}
beforeEach(async () => {
  process.env.USAGE_BUDGET_ORG_SCOPE_ID = unique('org');
  process.env.E2B_API_KEY = 'e2b-test-key';
  delete process.env.COMPUTER_MAX_RUNNING;
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  member = await createInternalTestUser(db, { email: `${unique('computer-member')}@test.local` });
  clientId = unique('client');
  await db.platformOAuth.registerClient({ id: clientId, client_name: 'Codex', redirect_uris: [] });
  // Other suites' committed rows must not fill the workspace limit here.
  process.env.COMPUTER_MAX_RUNNING = String((await computerServices(db).memberComputers.listActive()).length + 1);
  driver = fakeDriver();
  setComputerDriverForTests(driver);
  fakes.objects.clear();
  await setSwitch(true);
});
afterEach(async () => {
  vi.useRealTimers();
  setComputerDriverForTests(null);
  setPriceOverridesForTests([]);
  invalidateWorkspaceConfigCache();
  process.env = { ...savedEnv };
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});
describe('cloud computer: switched off', () => {
  beforeEach(async () => {
    await setSwitch(false);
  });
  it('never creates a sandbox, whatever the path', async () => {
    await expect(ensureComputer({ db, userId: member.id, scope: scope() })).rejects.toThrow(
      '云电脑未开启，请管理员在服务与计价里开启',
    );
    for (const [toolId, input] of [
      ['computer_exec', { command: 'ls', timeout_seconds: 10 }],
      ['computer_files', { action: 'list' }],
      ['computer_transfer', { action: 'computer.save_to_files', path: 'a.txt' }],
      ['computer_stop', {}],
    ] as const) {
      expect(await run(toolId, input)).toEqual({ error: COMPUTER_DISABLED_MESSAGE });
    }
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: member.id, role: 'team' } as never);
        await next();
      })
      .route('/', computerRoutes);
    const started = await app.request('/start', { method: 'POST' });
    expect(started.status).toBe(403);
    expect(
      (
        (await started.json()) as {
          error: string;
        }
      ).error,
    ).toContain('云电脑未开启');
    const report = (await (await app.request('/')).json()) as {
      enabled: boolean;
      computer: unknown;
    };
    expect(report).toMatchObject({ enabled: false, computer: null });
    await sweepComputers(db, { driver });
    expect(driver.create).not.toHaveBeenCalled();
  });
  it('lists no computer tool over MCP and names the reason when one is called anyway', async () => {
    const client = await connect(['mcp:read', 'mcp:write', 'mcp:computer']);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('computer_'))).toEqual([]);
    const result = (await client.callTool({
      name: 'computer_exec',
      arguments: { command: 'ls' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(COMPUTER_DISABLED_MESSAGE);
    expect(driver.create).not.toHaveBeenCalled();
    const runs = await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 5 });
    expect(runs.items).toEqual([]);
  });
  it('stops a computer still running when the switch goes off', async () => {
    await setSwitch(true);
    await ensureComputer({ db, userId: member.id, scope: scope() });
    await setSwitch(false);
    await sweepComputers(db, { driver });
    expect(await memberComputer()).toMatchObject({ status: 'stopped', stop_reason: 'disabled' });
    expect(driver.kill).toHaveBeenCalledTimes(1);
  });
});
describe('cloud computer: over MCP', () => {
  it('lists the computer tools with their tiers and annotations', async () => {
    const reader = await connect(['mcp:read', 'mcp:computer']);
    // team_context / data_catalog are protocol tools every grant lists.
    const notContextTool = (name: string) => name !== 'team_context' && name !== 'data_catalog';
    expect(
      (await reader.listTools()).tools
        .map((tool) => tool.name)
        .filter(notContextTool)
        .sort(),
    ).toEqual(['computer_files', 'tool_output_read']);
    const writer = await connect(['mcp:read', 'mcp:write', 'mcp:computer']);
    const listed = (await writer.listTools()).tools;
    expect(
      listed
        .map((tool) => tool.name)
        .filter(notContextTool)
        .sort(),
    ).toEqual(['computer_exec', 'computer_files', 'computer_stop', 'computer_transfer', 'tool_output_read']);
    const annotations = Object.fromEntries(listed.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.computer_files).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(annotations.computer_exec).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(annotations.computer_stop).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
  it('runs a command as a recorded write, starting the computer once and billing the agent', async () => {
    const client = await connect(['mcp:read', 'mcp:write', 'mcp:computer']);
    const first = (await client.callTool({ name: 'computer_exec', arguments: { command: 'echo hi' } })) as CallResult;
    expect(first.isError).toBeFalsy();
    expect(JSON.parse(first.content[0]!.text)).toMatchObject({ exit_code: 0, stdout: 'ran: echo hi\n' });
    expect(first.content.at(-1)!.text).toMatch(/^Recorded in Greenhouse as write /);
    await client.callTool({ name: 'computer_exec', arguments: { command: 'pwd' } });
    expect(driver.create).toHaveBeenCalledTimes(1);
    expect(driver.exec).toHaveBeenCalledTimes(2);
    const computer = await memberComputer();
    expect(computer).toMatchObject({ status: 'running', client: 'mcp', oauth_client_id: clientId });
    const [reserved] = await reservations(computer.budget_key!);
    expect(reserved).toMatchObject({ status: 'reserved', estimated_units: BLOCK });
    const runs = await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 5 });
    expect(
      runs.items.map(
        (row) =>
          (
            row.input as {
              tool_id?: string;
            }
          ).tool_id,
      ),
    ).toEqual(['computer_exec', 'computer_exec']);
    const stopped = (await client.callTool({ name: 'computer_stop', arguments: {} })) as CallResult;
    expect(JSON.parse(stopped.content[0]!.text)).toMatchObject({ status: 'stopped', minutes_billed: 1 });
    expect(await computerFacts()).toEqual([
      expect.objectContaining({ units: 1, unit_kind: 'minute', client: 'mcp', oauth_client_id: clientId }),
    ]);
  });
  it('refuses over budget before creating anything, in both languages', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0 });
    const client = await connect(['mcp:read', 'mcp:write', 'mcp:computer']);
    const result = (await client.callTool({ name: 'computer_exec', arguments: { command: 'ls' } })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/额度/);
    expect(result.content[0]!.text).toMatch(/budget/i);
    expect(driver.create).not.toHaveBeenCalled();
    expect(await memberComputer()).toMatchObject({ status: 'failed', stop_reason: 'budget' });
  });
});
describe('cloud computer: lifecycle and per-minute billing', () => {
  it('settles the minutes it ran on stop, at the price in force', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T08:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'make', timeout_seconds: 60 });
    const started = await memberComputer();
    vi.setSystemTime(t0 + 7 * MINUTE + 30000);
    const stopped = await stopMemberComputer(db, member.id, 'user', { driver });
    expect(stopped).toMatchObject({ status: 'stopped', stop_reason: 'user', minutes_billed: 8, budget_key: null });
    expect(driver.kill).toHaveBeenCalledWith(started.sandbox_id);
    const facts = await computerFacts();
    expect(facts).toEqual([expect.objectContaining({ units: 8, unit_kind: 'minute', run_id: started.id })]);
    expect(Number(facts[0]!.cost_usd_micros)).toBe(8 * PER_MINUTE);
    const [settled] = await reservations(started.budget_key!);
    expect(settled).toMatchObject({ status: 'settled', actual_units: 8 * PER_MINUTE });
  });
  it('stops an idle computer, and rolls the billing block of a busy one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T09:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    const first = await memberComputer();
    // Used again at 10 minutes: past the 15-minute block it is busy, so the block rolls.
    vi.setSystemTime(t0 + 10 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 0, rolled: 1 });
    const rolled = await memberComputer();
    expect(rolled).toMatchObject({ status: 'running', minutes_billed: 15 });
    expect(rolled.budget_key).not.toBe(first.budget_key);
    expect(new Date(rolled.block_started_at!).toISOString()).toBe(new Date(t0 + 15 * MINUTE).toISOString());
    expect((await reservations(first.budget_key!))[0]).toMatchObject({ status: 'settled', actual_units: BLOCK });
    // A second sweep in the same minute changes nothing.
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 0, rolled: 0 });
    // Idle for 15 minutes after its last use (t0 + 10m): stopped, the open block settled at what it ran.
    vi.setSystemTime(t0 + 25 * MINUTE);
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 1, rolled: 0 });
    expect(await memberComputer()).toMatchObject({ status: 'stopped', stop_reason: 'idle', minutes_billed: 25 });
    expect((await computerFacts()).map((fact) => fact.units)).toEqual([15, 10]);
    expect(driver.create).toHaveBeenCalledTimes(1);
  });
  it('gives the provider the first command time before its idle window starts', async () => {
    await run('computer_exec', { command: 'long-build', timeout_seconds: 600 });
    // 15 idle minutes + the 10-minute command + 2 minutes of slack.
    expect(driver.create).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 15 * 60 + 600 + 120 }));
  });
  it('keeps a busy computer alive at the provider while work runs, and once it ends', async () => {
    const computer = await ensureComputer({ db, userId: member.id, scope: scope() });
    driver.renew.mockClear();
    const before = (await memberComputer()).last_used_at;
    await withHeartbeat(db, computer, driver, () => new Promise((resolve) => setTimeout(resolve, 60)), {
      intervalMs: 10,
    });
    // At least one beat during the work, plus the closing renewal.
    expect(driver.renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [sandboxId, seconds] of driver.renew.mock.calls) {
      expect(sandboxId).toBe(computer.sandboxId);
      expect(seconds).toBe(15 * 60 + 120);
    }
    expect(Date.parse((await memberComputer()).last_used_at)).toBeGreaterThanOrEqual(Date.parse(before));
  });
  it('lets two sweeps of one block fund it once, and a stale refusal never stops a funded computer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T10:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 10 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    const snapshot = await memberComputer();
    // Process A rolls the block.
    expect(await rollComputerBlock(db, snapshot, driver)).toBe('rolled');
    const funded = await memberComputer();
    expect(funded.budget_key).toBe(`computer:${snapshot.id}:${new Date(t0 + 15 * MINUTE).toISOString()}`);
    // Process B, on the same snapshot, after the budget ran out: same block key,
    // so the same (funded) admission — it neither stops nor releases anything.
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0 });
    expect(await rollComputerBlock(db, snapshot, driver)).toBe('superseded');
    expect(await memberComputer()).toMatchObject({ status: 'running', budget_key: funded.budget_key });
    expect((await reservations(funded.budget_key!))[0]).toMatchObject({ status: 'reserved' });
    // The finished block was settled once.
    expect((await computerFacts()).map((fact) => fact.units)).toEqual([15]);
    // A refusal evaluated on the old block cannot stop the computer either.
    expect(await stopComputer(db, snapshot, 'budget', { driver, expect: { budgetKey: snapshot.budget_key } })).toBe(
      null,
    );
    expect(driver.kill).not.toHaveBeenCalled();
    expect((await memberComputer()).status).toBe('running');
  });
  it('keeps the funded block of a computer lost after the roll reserved, whatever a stale sweep does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T12:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 10 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    const snapshot = await memberComputer();
    // Sweeper A installs the next block; then a stop the provider does not confirm.
    expect(await rollComputerBlock(db, snapshot, driver)).toBe('rolled');
    const fundedKey = (await memberComputer()).budget_key!;
    driver.kill.mockRejectedValueOnce(new ProviderRequestError('Stopping the computer timed out after 30s.', 408));
    expect(await stopMemberComputer(db, member.id, 'user', { driver })).toMatchObject({
      status: 'lost',
      budget_key: null,
    });
    // Sweeper B, still on the old snapshot, must not make that runtime free.
    expect(await rollComputerBlock(db, snapshot, driver)).toBe('superseded');
    expect((await reservations(fundedKey))[0]).toMatchObject({ status: 'reserved' });
    await db.usageBudget.expireStaleReservations(new Date(Date.now() + 60 * MINUTE));
    expect((await reservations(fundedKey))[0]).toMatchObject({ status: 'expired', actual_units: BLOCK });
  });
  it('gives back a block reserved for a computer that stopped before it ever reached it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T13:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 10 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    const snapshot = await memberComputer();
    // The member stops it before any sweep rolled the block.
    await stopMemberComputer(db, member.id, 'user', { driver });
    expect(await rollComputerBlock(db, snapshot, driver)).toBe('superseded');
    const unusedKey = `computer:${snapshot.id}:${new Date(t0 + 15 * MINUTE).toISOString()}`;
    expect((await reservations(unusedKey)).map((row) => row.status)).toEqual(['released', 'released', 'released']);
  });
  /** A sweep reserves the next block, then dies before installing it. */
  async function crashAfterReserving(snapshot: MemberComputerRow) {
    const install = vi
      .spyOn(computerServices(db).memberComputers, 'rollBlock')
      .mockRejectedValueOnce(new Error('process died'));
    await expect(rollComputerBlock(db, snapshot, driver)).rejects.toThrow('process died');
    install.mockRestore();
  }
  it("finishes a half-done roll after a price change, keeping the block's original admission", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T14:00:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 10 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    const snapshot = await memberComputer();
    await crashAfterReserving(snapshot);
    const key = `computer:${snapshot.id}:${new Date(t0 + 15 * MINUTE).toISOString()}`;
    expect((await reservations(key))[0]).toMatchObject({ status: 'reserved', estimated_units: BLOCK });
    // An admin changes the price before the next sweep.
    await db.metering.setPriceOverride({ kind: 'service', target: 'computer', provider: 'e2b', unit_price: 0.003 });
    await syncPriceOverrides(db, true);
    vi.setSystemTime(t0 + 16 * MINUTE);
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 0, rolled: 1 });
    expect(await memberComputer()).toMatchObject({ status: 'running', budget_key: key, minutes_billed: 15 });
    expect((await reservations(key))[0]).toMatchObject({ status: 'reserved', estimated_units: BLOCK });
  });
  it('finishes a half-done roll across a month boundary against the month it was reserved in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-31T23:40:00.000Z');
    vi.setSystemTime(t0);
    await run('computer_exec', { command: 'serve', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 12 * MINUTE);
    await run('computer_exec', { command: 'test', timeout_seconds: 60 });
    vi.setSystemTime(t0 + 15 * MINUTE + 30000);
    const snapshot = await memberComputer();
    await crashAfterReserving(snapshot);
    const key = `computer:${snapshot.id}:${new Date(t0 + 15 * MINUTE).toISOString()}`;
    const reservedIn = (await reservations(key)).map((row) => row.account_id).sort();
    // The retry runs in November: fresh admission would use November's accounts.
    vi.setSystemTime(Date.parse('2026-11-01T00:01:00.000Z'));
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 0, rolled: 1 });
    expect(await memberComputer()).toMatchObject({ status: 'running', budget_key: key, minutes_billed: 15 });
    expect((await reservations(key)).map((row) => row.account_id).sort()).toEqual(reservedIn);
  });
  it('does not idle-stop a computer used after the snapshot the sweep decided on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-24T11:00:00.000Z');
    vi.setSystemTime(t0);
    await ensureComputer({ db, userId: member.id, scope: scope() });
    vi.setSystemTime(t0 + 16 * MINUTE);
    const stale = await memberComputer();
    // The member's agent uses it again before the sweep acts on its snapshot.
    await computerServices(db).memberComputers.touch(stale.id);
    const idleBefore = new Date(t0 + 16 * MINUTE - 15 * MINUTE).toISOString();
    expect(await stopComputer(db, stale, 'idle', { driver, expect: { idleBefore } })).toBe(null);
    expect(driver.kill).not.toHaveBeenCalled();
    expect((await memberComputer()).status).toBe('running');
    expect(await sweepComputers(db, { driver })).toEqual({ stopped: 0, rolled: 1 });
  });
  it('refuses a new computer once the workspace runs its limit', async () => {
    const other = await createInternalTestUser(db, { email: `${unique('computer-other')}@test.local` });
    await ensureComputer({ db, userId: other.id, scope: { userId: other.id, client: 'web' } });
    const result = await run('computer_exec', { command: 'ls', timeout_seconds: 10 });
    expect(result).toEqual({ error: expect.stringContaining('云电脑已满') });
    expect(driver.create).toHaveBeenCalledTimes(1);
  });
  it('leaves the block reserved when the provider does not confirm a stop (unknown outcome)', async () => {
    await ensureComputer({ db, userId: member.id, scope: scope() });
    const started = await memberComputer();
    driver.kill.mockRejectedValueOnce(new ProviderRequestError('Stopping the computer timed out after 30s.', 408));
    const lost = await stopMemberComputer(db, member.id, 'user', { driver });
    expect(lost).toMatchObject({ status: 'lost', stop_reason: 'lost', minutes_billed: 0 });
    expect(await computerFacts()).toEqual([]);
    expect((await reservations(started.budget_key!))[0]).toMatchObject({ status: 'reserved' });
    // The budget sweeper later charges the estimate.
    await db.usageBudget.expireStaleReservations(new Date(Date.now() + 60 * MINUTE));
    expect((await reservations(started.budget_key!))[0]).toMatchObject({ status: 'expired' });
  });
  it('gives the reservation back when the provider refuses a create, and keeps it when the outcome is unknown', async () => {
    driver.create.mockRejectedValueOnce(new ProviderRequestError('Creating the computer failed (HTTP 403).', 403));
    await expect(ensureComputer({ db, userId: member.id, scope: scope() })).rejects.toThrow(/403/);
    const refused = await memberComputer();
    expect(refused).toMatchObject({ status: 'failed', stop_reason: 'failed' });
    const refusedGroup = (await db.executeRaw(
      sql`SELECT status FROM budget_reservations WHERE run_id = ${refused.id}`,
    )) as Array<{
      status: string;
    }>;
    expect(refusedGroup.map((row) => row.status)).toEqual(['released', 'released', 'released']);
    driver.create.mockRejectedValueOnce(new ProviderRequestError('Creating the computer timed out after 120s.', 408));
    await expect(ensureComputer({ db, userId: member.id, scope: scope() })).rejects.toThrow(/timed out/);
    const unknown = await memberComputer();
    expect(unknown.id).not.toBe(refused.id);
    const unknownGroup = (await db.executeRaw(
      sql`SELECT status FROM budget_reservations WHERE run_id = ${unknown.id}`,
    )) as Array<{
      status: string;
    }>;
    expect(unknownGroup.map((row) => row.status)).toEqual(['reserved', 'reserved', 'reserved']);
  });
  it('moves files between Files and the computer, and reads never start one', async () => {
    expect(await run('computer_files', { action: 'list' })).toEqual({
      error: expect.stringMatching(/No cloud computer/),
    });
    expect(driver.create).not.toHaveBeenCalled();
    const cabinet = { db, userId: member.id, actor: delegatedAgentActor({ userId: member.id }) };
    const uploaded = await uploadCabinetFile(cabinet, {
      shelf: 'personal',
      name: 'data.csv',
      bytes: Buffer.from('a,b\n1,2\n'),
    });
    if ('error' in uploaded) throw new Error(uploaded.error);
    const copied = await run('computer_transfer', { action: 'files.copy_to_computer', file_id: uploaded.file.id });
    expect(copied).toMatchObject({ path: '/home/user/data.csv', size: 8 });
    expect(driver.files.get('/home/user/data.csv')?.toString()).toBe('a,b\n1,2\n');
    expect(await run('computer_files', { action: 'read', path: 'data.csv' })).toMatchObject({
      encoding: 'utf8',
      content: 'a,b\n1,2\n',
    });
    driver.files.set('/home/user/out/report.txt', Buffer.from('done'));
    const saved = (await run('computer_transfer', {
      action: 'computer.save_to_files',
      path: 'out/report.txt',
    })) as {
      file: {
        id: number;
        name: string;
        shelf: string;
      };
    };
    expect(saved.file).toMatchObject({ name: 'report.txt', shelf: 'personal' });
    const file = await db.drive.getFile(saved.file.id);
    expect(fakes.objects.get(file!.cos_key)?.buffer.toString()).toBe('done');
  });
  it("does not let a member copy in another member's private file", async () => {
    const other = await createInternalTestUser(db, { email: `${unique('computer-private')}@test.local` });
    const cabinet = { db, userId: other.id, actor: delegatedAgentActor({ userId: other.id }) };
    const uploaded = await uploadCabinetFile(cabinet, {
      shelf: 'personal',
      name: 'secret.txt',
      bytes: Buffer.from('x'),
    });
    if ('error' in uploaded) throw new Error(uploaded.error);
    const result = await run('computer_transfer', { action: 'files.copy_to_computer', file_id: uploaded.file.id });
    expect(result).toEqual({ error: expect.stringMatching(/No file with id/) });
    expect(driver.create).not.toHaveBeenCalled();
  });
});
