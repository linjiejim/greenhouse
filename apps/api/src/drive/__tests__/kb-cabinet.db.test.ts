/**
 * The knowledge cabinet behind Files and the files_* tools, on the real drive
 * tables: every node is authorized with the drive rule, personal shelves stay
 * private, moves never cross shelves, and writes leave an audit row.
 *
 * Object storage is an in-memory map — what is under test is who may touch
 * which row, not the bytes' backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { delegatedAgentActor } from '../../platform/actor.js';
import { PLATFORM_ORG_ID } from '../../platform/runtime.js';
import type { ToolRegistry } from '../../agent.js';
import { governProxyWrite } from '../../agent-access/governed-write.js';
import { createFilesMutationTool } from '../../tools/files-mutation.js';
import {
  createCabinetFolder,
  deleteCabinetFile,
  getCabinetFile,
  listCabinetFolder,
  readCabinetFile,
  searchCabinet,
  updateCabinetFile,
  updateCabinetFolder,
  uploadCabinetFile,
  type CabinetCaller,
} from '../kb-cabinet.js';

const objects = new Map<string, Buffer>();

vi.mock('../../storage/uploads.js', () => ({
  driveKeyFor: (opts: { filename: string }) => `drive/test/${Math.random().toString(36).slice(2)}-${opts.filename}`,
  putObjectAtKey: async (key: string, buffer: Buffer) => {
    objects.set(key, buffer);
  },
  getObjectAtKey: async (key: string) => {
    const buffer = objects.get(key);
    return buffer ? { buffer, contentType: 'application/octet-stream' } : null;
  },
  deleteObjectAtKey: async (key: string) => {
    objects.delete(key);
  },
  presignGetUrl: async () => null,
}));

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function as(user: UserRow): CabinetCaller {
  return { db, userId: user.id, actor: delegatedAgentActor({ userId: user.id }) };
}

function ok<T>(value: T | { error: string }): T {
  if (value && typeof value === 'object' && 'error' in value) throw new Error(`unexpected refusal: ${value.error}`);
  return value as T;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('cab-alice')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('cab-bob')}@test.local` });
  objects.clear();
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('knowledge cabinet access', () => {
  it('keeps a personal shelf to its owner and shares the team shelf', async () => {
    const mine = ok(await createCabinetFolder(as(alice), { shelf: 'personal', name: unique('Private') }));
    const team = ok(await createCabinetFolder(as(alice), { shelf: 'team', name: unique('Shared') }));

    // Bob reaches the team folder, never Alice's personal one — not by id either.
    expect('error' in (await listCabinetFolder(as(bob), { shelf: 'team', folderId: team.folder.id }))).toBe(false);
    const peek = await listCabinetFolder(as(bob), { shelf: 'personal', folderId: mine.folder.id });
    expect(peek).toMatchObject({ error: expect.stringContaining('No folder') });
    const bobsPersonal = ok(await listCabinetFolder(as(bob), { shelf: 'personal' }));
    expect(bobsPersonal.folders.map((f) => f.id)).not.toContain(mine.folder.id);

    // Nor can he write into it.
    const intrude = await createCabinetFolder(as(bob), { shelf: 'personal', parentId: mine.folder.id, name: 'x' });
    expect(intrude).toMatchObject({ error: expect.any(String) });
  });

  it('uploads, reads and finds a text file only where the caller may look', async () => {
    const name = `${unique('notes')}.md`;
    const uploaded = ok(
      await uploadCabinetFile(as(alice), { shelf: 'personal', name, bytes: Buffer.from('# Plan\nShip it.') }),
    );
    expect(uploaded.file).toMatchObject({ name, shelf: 'personal', url: expect.stringContaining('shelf=personal') });

    const read = ok(await readCabinetFile(as(alice), { fileId: uploaded.file.id }));
    expect(read.text).toContain('Ship it.');

    const aliceSearch = ok(await searchCabinet(as(alice), { query: name.slice(0, 20) }));
    expect(aliceSearch.files.map((f) => f.id)).toContain(uploaded.file.id);
    const bobSearch = ok(await searchCabinet(as(bob), { query: name.slice(0, 20) }));
    expect(bobSearch.files.map((f) => f.id)).not.toContain(uploaded.file.id);
    expect(await getCabinetFile(as(bob), uploaded.file.id)).toMatchObject({
      error: expect.stringContaining('No file'),
    });
    expect(await readCabinetFile(as(bob), { fileId: uploaded.file.id })).toMatchObject({ error: expect.any(String) });
  });

  it('refuses a move across shelves and a rename the upload policy would refuse', async () => {
    const teamFolder = ok(await createCabinetFolder(as(alice), { shelf: 'team', name: unique('Team') }));
    const file = ok(
      await uploadCabinetFile(as(alice), { shelf: 'personal', name: `${unique('a')}.txt`, bytes: Buffer.from('a') }),
    );

    const crossed = await updateCabinetFile(as(alice), { fileId: file.file.id, folderId: teamFolder.folder.id });
    expect(crossed).toMatchObject({ error: expect.stringContaining('shelf') });

    const html = await updateCabinetFile(as(alice), { fileId: file.file.id, name: 'page.html' });
    expect(html).toMatchObject({ error: expect.any(String) });

    const renamed = ok(await updateCabinetFile(as(alice), { fileId: file.file.id, name: 'renamed.txt' }));
    expect(renamed.file.name).toBe('renamed.txt');
  });

  it('refuses moving a folder into its own subfolder', async () => {
    const parent = ok(await createCabinetFolder(as(alice), { shelf: 'team', name: unique('Parent') }));
    const child = ok(
      await createCabinetFolder(as(alice), { shelf: 'team', parentId: parent.folder.id, name: unique('Child') }),
    );
    const cycle = await updateCabinetFolder(as(alice), { folderId: parent.folder.id, parentId: child.folder.id });
    expect(cycle).toMatchObject({ error: expect.stringContaining('itself') });
  });

  it('records each change in the platform audit, named by the actor', async () => {
    const file = ok(
      await uploadCabinetFile(as(alice), { shelf: 'team', name: `${unique('audit')}.txt`, bytes: Buffer.from('x') }),
    );
    ok(await deleteCabinetFile(as(alice), file.file.id));
    const events = (await db.platform.listAuditEventsForApp(PLATFORM_ORG_ID, 'drive', 50)).filter(
      (event) => event.record_id === String(file.file.id),
    );
    expect(events.map((event) => event.action_id).sort()).toEqual(['deleteFile', 'uploadFile']);
    expect(events.every((event) => event.on_behalf_of_user_id === alice.id && event.actor_type === 'agent')).toBe(true);
  });
});

describe('files_mutation over the recorded-write path', () => {
  it('previews a delete, then deletes once confirmed — and only what the member may change', async () => {
    const file = ok(
      await uploadCabinetFile(as(alice), { shelf: 'team', name: `${unique('gone')}.txt`, bytes: Buffer.from('bye') }),
    );
    const client = await db.platformOAuth.registerClient({
      id: unique('client'),
      client_name: 'Claude Code',
      redirect_uris: '[]',
      created_by: alice.id,
    });
    const registry = { files_mutation: createFilesMutationTool(db, { userId: alice.id }) } as unknown as ToolRegistry;
    const govern = (confirmed: boolean) =>
      governProxyWrite({
        db,
        caller: { userId: alice.id, clientId: client.id, clientName: 'Claude Code', authMethod: 'oauth' },
        toolId: 'files_mutation',
        input: { action: 'files.delete', file_id: file.file.id },
        registry,
        allowedToolIds: ['files_mutation'],
        baseRisk: 'r2',
        confirmed,
      });

    const preview = await govern(false);
    expect(preview.status).toBe('needs_confirmation');
    expect((await db.drive.getFile(file.file.id))?.status).toBe('active');

    const done = await govern(true);
    expect(done.status).toBe('executed');
    expect((await db.drive.getFile(file.file.id))?.status).toBe('deleted');
    if (done.status === 'executed') expect(done.view).toMatchObject({ client_name: 'Claude Code', basis: 'confirmed' });

    // Bob's agent cannot touch Alice's personal file even with confirm:true.
    const personal = ok(
      await uploadCabinetFile(as(alice), { shelf: 'personal', name: `${unique('p')}.txt`, bytes: Buffer.from('p') }),
    );
    const bobsTool = createFilesMutationTool(db, { userId: bob.id }) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const refused = await bobsTool.execute({ action: 'files.delete', file_id: personal.file.id }, {});
    expect(refused).toMatchObject({ error: expect.stringContaining('No file') });
    expect((await db.drive.getFile(personal.file.id))?.status).toBe('active');
  });
});
