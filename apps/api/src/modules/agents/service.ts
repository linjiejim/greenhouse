/**
 * Agents: every member's main Agent (Greeny by default, handle `main`) and the private Agents
 * they create. The definition is an immutable manifest; each save appends a version, and
 * `agent:<id>@<version>` pins one. Only the owner reads or changes an Agent.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  agentManifestSchema,
  MAX_AGENTS,
  type Agent,
  type AgentAvatar,
  type AgentDetail,
  type AgentManifest,
  type AgentMemory,
  type AgentVersion,
  type createAgentInputSchema,
  type memoryInputSchema,
  type UpdateMemoryInput,
  type updateAgentInputSchema,
} from '@greenhouse/contract';
import {
  agentMemories,
  agents,
  agentVersions,
  conversations,
  getDb,
  members,
  newId,
  transaction,
  type Agent as AgentRow,
  type AgentMemory as MemoryRow,
} from '@greenhouse/db';
import {
  agentTemplate,
  MAIN_AGENT_TEMPLATE,
  RESERVED_AGENT_NAMES,
  type AgentLocale,
} from '@greenhouse/types/agent-templates';
import { hashSeed, PLANT_IDS, PLANT_TINTS, TEMPLATE_PLANT, type PlantId } from '@greenhouse/types/plant-avatar';
import { isUniqueViolation } from '@greenhouse/utils/error';
import type { z } from 'zod';
import { conflict, invalidInput, notFound } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';

type CreateInput = z.output<typeof createAgentInputSchema>;
type UpdateInput = z.output<typeof updateAgentInputSchema>;
type MemoryInput = z.output<typeof memoryInputSchema>;

export interface LoadedAgent {
  agent: AgentRow;
  manifest: AgentManifest;
  version: number;
}

const localeOf = (locale: string): AgentLocale => (locale === 'en' ? 'en' : 'zh');
const nameKey = (name: string) => name.trim().toLowerCase();
export const handleOf = (agent: Pick<AgentRow, 'id' | 'isMain'>) => (agent.isMain ? 'main' : `agent:${agent.id}`);

/** Plants no template uses, so a blank Agent never looks like Greeny or a gallery Agent. */
const FREE_PLANTS = PLANT_IDS.filter((plant) => !(Object.values(TEMPLATE_PLANT) as string[]).includes(plant));

/** Keep only a known plant and a known non-default tint. */
function cleanAvatar(avatar: AgentAvatar | undefined, fallback: PlantId): AgentAvatar {
  const plant = avatar?.plant && (PLANT_IDS as readonly string[]).includes(avatar.plant) ? avatar.plant : fallback;
  const tint =
    avatar?.tint && avatar.tint !== 'plant' && (PLANT_TINTS as readonly string[]).includes(avatar.tint)
      ? avatar.tint
      : undefined;
  return tint ? { plant, tint } : { plant };
}

function parseManifest(value: unknown): AgentManifest {
  const parsed = agentManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidInput(
    'Some fields are invalid.',
    parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

/** Canonical JSON: sorted keys, so the same manifest always hashes the same. */
function canonical(manifest: AgentManifest): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(sort(manifest));
}

const toAgent = (row: AgentRow, manifest: AgentManifest): Agent => ({
  id: row.id,
  handle: handleOf(row),
  name: row.name,
  role: row.role,
  description: manifest.description,
  avatar: row.avatar as AgentAvatar,
  is_main: row.isMain,
  visibility: row.visibility,
  template_key: row.templateKey,
  current_version: row.currentVersion,
  archived_at: row.archivedAt,
  last_active_at: row.lastActiveAt,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const toMemory = (row: MemoryRow): AgentMemory => ({
  id: row.id,
  agent_id: row.agentId,
  title: row.title,
  content: row.content,
  category: row.category,
  status: row.status,
  pinned: row.pinned,
  source: row.source,
  last_used_at: row.lastUsedAt,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

export function createAgentsService(deps: { providers: ProvidersService }) {
  async function memberOf(memberId: string) {
    const [member] = await getDb().select().from(members).where(eq(members.id, memberId));
    if (!member) throw notFound('Member');
    return member;
  }

  async function manifestOf(agentId: string, version: number): Promise<AgentManifest> {
    const [row] = await getDb()
      .select({ manifest: agentVersions.manifest })
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
    if (!row) throw notFound('Agent version');
    return agentManifestSchema.parse(JSON.parse(row.manifest));
  }

  async function appendVersion(
    agentId: string,
    version: number,
    manifest: AgentManifest,
    actorId: string,
    note: string,
  ) {
    const text = canonical(manifest);
    await getDb()
      .insert(agentVersions)
      .values({
        id: newId('agentVersion'),
        agentId,
        version,
        manifest: text,
        manifestHash: createHash('sha256').update(text).digest('hex'),
        changeNote: note,
        createdBy: actorId,
      });
  }

  /** Names are unique among an owner's live Agents and never a transcript speaker label. */
  async function assertName(ownerId: string, name: string, exceptId?: string) {
    if ((RESERVED_AGENT_NAMES as readonly string[]).includes(nameKey(name))) {
      throw invalidInput(`"${name.trim()}" is reserved; choose another name.`);
    }
    const [clash] = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.ownerId, ownerId),
          eq(agents.nameKey, nameKey(name)),
          isNull(agents.archivedAt),
          exceptId ? ne(agents.id, exceptId) : undefined,
        ),
      );
    if (clash) throw conflict('agent_name_taken', 'You already have an Agent with this name.');
  }

  async function assertModel(ref: string, memberId: string) {
    if (!(await deps.providers.modelAvailable(ref, { memberId }))) {
      throw invalidInput(`The model "${ref}" is not available.`);
    }
  }

  async function ownAgent(memberId: string, idOrHandle: string): Promise<AgentRow> {
    if (idOrHandle === 'main') return service.ensureMain(memberId);
    const id = idOrHandle.startsWith('agent:') ? idOrHandle.slice('agent:'.length).split('@')[0]! : idOrHandle;
    const [row] = await getDb()
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.ownerId, memberId)));
    if (!row) throw notFound('Agent');
    return row;
  }

  /** The conversation an Agent's profile opens: the main thread, or its Agent thread once it exists. */
  async function conversationOf(memberId: string, agent: AgentRow): Promise<string | null> {
    const [row] = await getDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.ownerId, memberId),
          agent.isMain
            ? eq(conversations.kind, 'main')
            : and(eq(conversations.kind, 'direct'), eq(conversations.agentId, agent.id)),
        ),
      );
    return row?.id ?? null;
  }

  async function detail(memberId: string, row: AgentRow): Promise<AgentDetail> {
    const manifest = await manifestOf(row.id, row.currentVersion);
    return {
      ...toAgent(row, manifest),
      instructions: manifest.instructions,
      model: manifest.model,
      skills: manifest.skills,
      connectors: manifest.connectors,
      tools: manifest.tools,
      write: manifest.write,
      conversation_id: await conversationOf(memberId, row),
    };
  }

  const service = {
    /** The member's main Agent, created on first use in their language. Safe to call concurrently. */
    async ensureMain(memberId: string): Promise<AgentRow> {
      const [existing] = await getDb()
        .select()
        .from(agents)
        .where(and(eq(agents.ownerId, memberId), eq(agents.isMain, true)));
      if (existing) return existing;
      const member = await memberOf(memberId);
      const copy = MAIN_AGENT_TEMPLATE.copy[localeOf(member.locale)];
      const manifest: AgentManifest = {
        name: copy.name,
        role: copy.role,
        description: copy.pitch,
        instructions: copy.instructions,
        avatar: { plant: MAIN_AGENT_TEMPLATE.plant },
        model: 'default',
        skills: [],
        connectors: null,
        tools: null,
        write: true,
      };
      const created = await transaction(async (db) => {
        const id = newId('agent');
        // A name another Agent already uses gets a number, so the main Agent always exists.
        const [{ n }] = (await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agents)
          .where(
            and(eq(agents.ownerId, memberId), eq(agents.nameKey, nameKey(copy.name)), isNull(agents.archivedAt)),
          )) as [{ n: number }];
        const name = n ? `${copy.name} ${n + 1}` : copy.name;
        const [row] = await db
          .insert(agents)
          .values({
            id,
            ownerId: memberId,
            isMain: true,
            name,
            nameKey: nameKey(name),
            role: copy.role,
            avatar: manifest.avatar,
            templateKey: MAIN_AGENT_TEMPLATE.key,
          })
          .onConflictDoNothing()
          .returning();
        if (row) await appendVersion(id, 1, { ...manifest, name }, memberId, '');
        return row;
      });
      if (created) return created;
      // Another request created it first.
      const [winner] = await getDb()
        .select()
        .from(agents)
        .where(and(eq(agents.ownerId, memberId), eq(agents.isMain, true)));
      return winner!;
    },

    async list(memberId: string, scope: 'mine' | 'archived'): Promise<Agent[]> {
      if (scope === 'mine') await service.ensureMain(memberId);
      const rows = await getDb()
        .select({ agent: agents, manifest: agentVersions.manifest })
        .from(agents)
        .innerJoin(
          agentVersions,
          and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.currentVersion)),
        )
        .where(
          and(
            eq(agents.ownerId, memberId),
            scope === 'mine' ? isNull(agents.archivedAt) : isNotNull(agents.archivedAt),
          ),
        )
        .orderBy(desc(agents.isMain), asc(agents.nameKey));
      return rows.map((row) => toAgent(row.agent, agentManifestSchema.parse(JSON.parse(row.manifest))));
    },

    async get(memberId: string, idOrHandle: string): Promise<AgentDetail> {
      return detail(memberId, await ownAgent(memberId, idOrHandle));
    },

    /** What a turn runs on: the Agent and the manifest of its current or pinned version. */
    async load(memberId: string, idOrHandle: string): Promise<LoadedAgent> {
      const agent = await ownAgent(memberId, idOrHandle);
      const pinned = /@(\d+)$/.exec(idOrHandle);
      const version = pinned ? Number(pinned[1]) : agent.currentVersion;
      return { agent, manifest: await manifestOf(agent.id, version), version };
    },

    async create(memberId: string, input: CreateInput): Promise<AgentDetail> {
      const template = input.template_key ? agentTemplate(input.template_key) : undefined;
      if (input.template_key && (!template || template.key === MAIN_AGENT_TEMPLATE.key)) {
        throw invalidInput(`There is no template called "${input.template_key}".`);
      }
      const member = await memberOf(memberId);
      const copy = template?.copy[localeOf(member.locale)];
      const id = newId('agent');
      const manifest = parseManifest({
        name: input.name ?? copy?.name ?? '',
        role: input.role ?? copy?.role ?? '',
        description: input.description ?? copy?.pitch ?? '',
        instructions: input.instructions ?? copy?.instructions ?? '',
        avatar: cleanAvatar(input.avatar, template?.plant ?? FREE_PLANTS[hashSeed(id) % FREE_PLANTS.length]!),
        model: input.model ?? 'default',
        skills: input.skills ?? [],
        connectors: input.connectors ?? null,
        tools: input.tools ?? null,
        write: input.write ?? true,
      });
      await assertName(memberId, manifest.name);
      await assertModel(manifest.model, memberId);
      await service.ensureMain(memberId);
      try {
        const row = await transaction(async (db) => {
          const [{ n }] = (await db
            .select({ n: sql<number>`count(*)::int` })
            .from(agents)
            .where(and(eq(agents.ownerId, memberId), eq(agents.isMain, false), isNull(agents.archivedAt)))) as [
            { n: number },
          ];
          if (n >= MAX_AGENTS)
            throw conflict('agent_limit', `You can have up to ${MAX_AGENTS} Agents besides your main one.`);
          const [created] = await db
            .insert(agents)
            .values({
              id,
              ownerId: memberId,
              name: manifest.name,
              nameKey: nameKey(manifest.name),
              role: manifest.role,
              avatar: manifest.avatar,
              templateKey: template?.key ?? null,
            })
            .returning();
          await appendVersion(id, 1, manifest, memberId, '');
          return created!;
        });
        return detail(memberId, row);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('agent_name_taken', 'You already have an Agent with this name.');
        throw error;
      }
    },

    /** Appends a version; the row mirrors what lists show. */
    async update(memberId: string, idOrHandle: string, input: UpdateInput): Promise<AgentDetail> {
      const row = await ownAgent(memberId, idOrHandle);
      if (row.archivedAt) throw conflict('agent_archived', 'Restore this Agent before changing it.');
      const current = await manifestOf(row.id, row.currentVersion);
      const { change_note: note, ...changes } = input;
      const next = parseManifest({
        ...current,
        ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
        avatar: changes.avatar
          ? cleanAvatar(changes.avatar, (current.avatar.plant as PlantId) ?? 'sprout')
          : current.avatar,
      });
      if (canonical(next) === canonical(current)) return detail(memberId, row);
      if (next.name !== current.name) await assertName(memberId, next.name, row.id);
      if (next.model !== current.model) await assertModel(next.model, memberId);
      try {
        const updated = await transaction(async (db) => {
          // The version check makes concurrent saves append one after the other, never the same number twice.
          const version = row.currentVersion + 1;
          await appendVersion(row.id, version, next, memberId, note ?? '');
          const [saved] = await db
            .update(agents)
            .set({
              name: next.name,
              nameKey: nameKey(next.name),
              role: next.role,
              avatar: next.avatar,
              currentVersion: version,
              updatedAt: sql`now()`,
            })
            .where(and(eq(agents.id, row.id), eq(agents.currentVersion, row.currentVersion)))
            .returning();
          if (!saved) throw conflict('agent_changed', 'This Agent changed in the meantime; reload and try again.');
          return saved;
        });
        return detail(memberId, updated);
      } catch (error) {
        if (isUniqueViolation(error))
          throw conflict('agent_changed', 'This Agent changed in the meantime; reload and try again.');
        throw error;
      }
    },

    async archive(memberId: string, idOrHandle: string): Promise<void> {
      const row = await ownAgent(memberId, idOrHandle);
      if (row.isMain) throw conflict('agent_protected', 'Your main Agent cannot be archived.');
      if (row.archivedAt) return;
      await getDb()
        .update(agents)
        .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(agents.id, row.id));
    },

    async restore(memberId: string, idOrHandle: string): Promise<AgentDetail> {
      const row = await ownAgent(memberId, idOrHandle);
      if (!row.archivedAt) return detail(memberId, row);
      await assertName(memberId, row.name, row.id);
      const [restored] = await getDb()
        .update(agents)
        .set({ archivedAt: null, updatedAt: sql`now()` })
        .where(eq(agents.id, row.id))
        .returning();
      return detail(memberId, restored!);
    },

    async versions(memberId: string, idOrHandle: string): Promise<AgentVersion[]> {
      const row = await ownAgent(memberId, idOrHandle);
      const rows = await getDb()
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, row.id))
        .orderBy(desc(agentVersions.version));
      return rows.map((version) => ({
        version: version.version,
        manifest: agentManifestSchema.parse(JSON.parse(version.manifest)),
        change_note: version.changeNote,
        created_by: version.createdBy,
        created_at: version.createdAt,
      }));
    },

    async touch(agentId: string): Promise<void> {
      await getDb()
        .update(agents)
        .set({ lastActiveAt: sql`now()` })
        .where(eq(agents.id, agentId));
    },

    async memories(memberId: string, idOrHandle: string, status: 'active' | 'all' = 'active'): Promise<AgentMemory[]> {
      const row = await ownAgent(memberId, idOrHandle);
      const rows = await getDb()
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, row.id),
            eq(agentMemories.memberId, memberId),
            status === 'active' ? eq(agentMemories.status, 'active') : undefined,
          ),
        )
        .orderBy(desc(agentMemories.pinned), desc(agentMemories.updatedAt));
      return rows.map(toMemory);
    },

    async remember(
      memberId: string,
      idOrHandle: string,
      input: MemoryInput,
      origin: { source: 'member' | 'agent'; conversationId?: string } = { source: 'member' },
    ): Promise<AgentMemory> {
      const row = await ownAgent(memberId, idOrHandle);
      const [created] = await getDb()
        .insert(agentMemories)
        .values({
          id: newId('memory'),
          agentId: row.id,
          memberId,
          title: input.title,
          content: input.content,
          category: input.category,
          pinned: input.pinned,
          source: origin.source,
          sourceConversationId: origin.conversationId ?? null,
        })
        .returning();
      return toMemory(created!);
    },

    async updateMemory(memberId: string, idOrHandle: string, memoryId: string, input: UpdateMemoryInput) {
      const row = await ownAgent(memberId, idOrHandle);
      const [updated] = await getDb()
        .update(agentMemories)
        .set({ ...input, updatedAt: sql`now()` })
        .where(
          and(eq(agentMemories.id, memoryId), eq(agentMemories.agentId, row.id), eq(agentMemories.memberId, memberId)),
        )
        .returning();
      if (!updated) throw notFound('Memory');
      return toMemory(updated);
    },

    /** Forgetting deletes the memory outright. */
    async forget(memberId: string, idOrHandle: string, memoryId: string): Promise<void> {
      const row = await ownAgent(memberId, idOrHandle);
      const deleted = await getDb()
        .delete(agentMemories)
        .where(
          and(eq(agentMemories.id, memoryId), eq(agentMemories.agentId, row.id), eq(agentMemories.memberId, memberId)),
        )
        .returning({ id: agentMemories.id });
      if (!deleted.length) throw notFound('Memory');
    },
  };
  return service;
}

export type AgentsService = ReturnType<typeof createAgentsService>;
