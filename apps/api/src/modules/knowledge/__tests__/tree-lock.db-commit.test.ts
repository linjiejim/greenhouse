/**
 * The knowledge tree lock across processes: a move holds it alone, so sharing, creating and
 * uploading wait for a move under way and then act on where things are now, never on where they
 * were when they first looked.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { docs, files, folders, getDb, members, newId, shares } from '@greenhouse/db';
import { createServices } from '../../../app.js';
import { loadConfig } from '../../../config/index.js';

/** The knowledge service's tree lock (service.ts). */
const TREE_LOCK = 74_192_101;
const createdMembers: string[] = [];
/** Rows that leave their owner's space (moved into the team space) and so outlive the member. */
const teamFolders: string[] = [];

afterAll(async () => {
  if (teamFolders.length) {
    await getDb().delete(files).where(inArray(files.folderId, teamFolders));
    await getDb().delete(docs).where(inArray(docs.folderId, teamFolders));
    await getDb().delete(folders).where(inArray(folders.id, teamFolders));
  }
  if (createdMembers.length) {
    await getDb().delete(shares).where(inArray(shares.createdBy, createdMembers));
    await getDb().delete(members).where(inArray(members.id, createdMembers));
  }
});

function apiProcess() {
  return createServices(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused/test',
      TOKEN_SIGNING_KEY: 'a'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: 'b'.repeat(64),
      PUBLIC_URL: 'http://greenhouse.test',
      STORAGE_PROVIDER: 'local',
      STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-tree-lock-')),
    }),
  );
}

async function member(name: string): Promise<string> {
  const id = newId('member');
  createdMembers.push(id);
  await getDb()
    .insert(members)
    .values({ id, email: `${id.toLowerCase()}@example.com`, name, status: 'active' });
  return id;
}

/** Another process's move: takes the tree lock, does its writes, and commits a moment later. */
async function moveUnderWay(
  work: (tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) => Promise<void>,
) {
  let holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  const committed = getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TREE_LOCK})`);
    await work(tx);
    holding();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await held;
  // Wrapped, or awaiting this would wait for the commit too.
  return { committed };
}

describe('the knowledge tree lock', () => {
  it('makes sharing wait for a move into an Agent’s folder, then refuse', async () => {
    const services = apiProcess();
    const lin = await member('Lin');
    const chen = await member('Chen');
    const main = await services.agents.ensureMain(lin);
    const own = (await services.knowledge.agentFolder(main, true))!;
    const doc = await services.knowledge.createDoc(lin, { title: 'Draft' });

    const { committed } = await moveUnderWay(async (tx) => {
      await tx.update(docs).set({ folderId: own.id }).where(eq(docs.id, doc.id));
    });
    const sharing = services.knowledge.share(lin, 'doc', doc.id, {
      items: [{ type: 'member', id: chen, role: 'viewer' }],
    });
    await committed;
    await expect(sharing).rejects.toMatchObject({ code: 'agent_folder_private' });
    expect(await getDb().select().from(shares).where(eq(shares.resourceId, doc.id))).toEqual([]);
  });

  it('makes a new doc and a new file wait for their folder’s move into the team space and land there', async () => {
    const services = apiProcess();
    const lin = await member('Lin');
    const folder = await services.knowledge.createFolder(lin, { name: 'Drafts' });
    teamFolders.push(folder.id);

    const { committed } = await moveUnderWay(async (tx) => {
      await tx.update(folders).set({ space: 'team', ownerId: null }).where(eq(folders.id, folder.id));
    });
    const creating = services.knowledge.createDoc(lin, { title: 'Plan', folder_id: folder.id });
    const uploading = services.knowledge.upload(lin, {
      name: 'notes.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('notes'),
      folderId: folder.id,
    });
    await committed;
    expect(await creating).toMatchObject({ space: 'team', owner_id: null, folder_id: folder.id });
    expect(await uploading).toMatchObject({ space: 'team', owner_id: null, folder_id: folder.id });
  });
});
