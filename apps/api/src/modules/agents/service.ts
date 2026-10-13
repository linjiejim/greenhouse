/**
 * Agents: every member's main Agent (Greeny by default, handle `main`) and the private Agents
 * they create. The definition is an immutable manifest; each save appends a version, and
 * `agent:<id>@<version>` pins one. Only the owner reads or changes an Agent.
 *
 * An owner may publish a version of an Agent (never the main one) to members, groups or the
 * whole workspace (shares, resource `agent`, role `user`). Its audience sees the published
 * version's face and talks to it in their own Agent thread; its turns act with the asker's
 * rights and keep a memory per asker (engine/AGENTS.md). An admin can pause it.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  agentManifestSchema,
  MAX_AGENTS,
  type AdminPublicAgent,
  type Agent,
  type AgentAvatar,
  type AgentDetail,
  type AgentManifest,
  type AgentMemory,
  type AgentVersion,
  type Page,
  type Publication,
  type PublicAgent,
  type createAgentInputSchema,
  type memoryInputSchema,
  type publicationInputSchema,
  type UpdateMemoryInput,
  type updateAgentInputSchema,
} from '@greenhouse/contract';
import {
  agentMemories,
  agents,
  agentVersions,
  conversations,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  runs,
  shares,
  transaction,
  usageEvents,
  workspace,
  type Agent as AgentRow,
  type AgentMemory as MemoryRow,
  type Member,
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
import { audit, changedFields } from '../../audit.js';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { currentMonth } from '../../providers/budgets.js';
import type { ProvidersService } from '../../providers/service.js';
import type { FilesService } from '../files/service.js';
import { summaryFor } from '../members/service.js';
import { totalsColumns, toTotals } from '../usage/totals.js';

type CreateInput = z.output<typeof createAgentInputSchema>;
type UpdateInput = z.output<typeof updateAgentInputSchema>;
type MemoryInput = z.output<typeof memoryInputSchema>;
type PublicationSave = z.output<typeof publicationInputSchema>;

export interface LoadedAgent {
  agent: AgentRow;
  manifest: AgentManifest;
  version: number;
}

/** A turn of someone else's public Agent: whose it is, and what its publication allows. */
export interface PublicTurn {
  ownerId: string;
  ownerName: string;
  /** The asker gets their own copy of its computer. */
  computer: boolean;
  /** Replies per asker per day; 0 is no limit. */
  dailyCap: number;
}

/** What a turn runs on; `public` is set when the asker is not the owner. */
export interface TurnAgent extends LoadedAgent {
  public: PublicTurn | null;
}

/** A public Agent as one member of its audience may use it. */
interface Shared {
  agent: AgentRow;
  owner: Member;
  version: number;
  manifest: AgentManifest;
}

const localeOf = (locale: string): AgentLocale => (locale === 'en' ? 'en' : 'zh');
const nameKey = (name: string) => name.trim().toLowerCase();
export const handleOf = (agent: Pick<AgentRow, 'id' | 'isMain'>) => (agent.isMain ? 'main' : `agent:${agent.id}`);
/** The id in `agent:<id>@<version>`, `agent:<id>` or a bare id. */
export const agentIdOf = (idOrHandle: string) =>
  idOrHandle.startsWith('agent:') ? idOrHandle.slice('agent:'.length).split('@')[0]! : idOrHandle;

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
  owner_id: row.ownerId,
  visibility: row.visibility,
  published_version: row.publishedVersion,
  paused_at: row.pausedAt,
  template_key: row.templateKey,
  current_version: row.currentVersion,
  archived_at: row.archivedAt,
  last_active_at: row.lastActiveAt,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

/** The row as its audience sees it: the published version's name, role and avatar. */
const withPublishedFace = (row: AgentRow, manifest: AgentManifest): AgentRow => ({
  ...row,
  name: manifest.name,
  role: manifest.role,
  avatar: manifest.avatar,
});

/** Published (public, with a pinned version) and not its viewer's own. */
const publishedFor = (memberId: string) =>
  and(eq(agents.visibility, 'public'), isNotNull(agents.publishedVersion), ne(agents.ownerId, memberId));

/** The Agent row is shared with the member: directly, through a group, or with everyone. */
const sharedWith = (memberId: string) =>
  exists(
    getDb()
      .select({ one: sql`1` })
      .from(shares)
      .where(
        and(
          eq(shares.resourceType, 'agent'),
          eq(shares.resourceId, agents.id),
          or(
            eq(shares.principalType, 'workspace'),
            and(eq(shares.principalType, 'member'), eq(shares.principalId, memberId)),
            and(
              eq(shares.principalType, 'group'),
              inArray(
                shares.principalId,
                getDb()
                  .select({ id: groupMembers.groupId })
                  .from(groupMembers)
                  .where(eq(groupMembers.memberId, memberId)),
              ),
            ),
          ),
        ),
      ),
  );

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

export function createAgentsService(deps: { providers: ProvidersService; files: FilesService }) {
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

  async function findOwn(memberId: string, idOrHandle: string): Promise<AgentRow | null> {
    if (idOrHandle === 'main') return service.ensureMain(memberId);
    const [row] = await getDb()
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentIdOf(idOrHandle)), eq(agents.ownerId, memberId)));
    return row ?? null;
  }

  async function ownAgent(memberId: string, idOrHandle: string): Promise<AgentRow> {
    const row = await findOwn(memberId, idOrHandle);
    if (!row) throw notFound('Agent');
    return row;
  }

  /**
   * Someone else's Agent, published and shared with this member, with its owner still active. A
   * paused or archived one is returned too: callers decide what those mean.
   */
  async function shared(memberId: string, agentId: string): Promise<Shared | null> {
    const [row] = await getDb()
      .select({ agent: agents, owner: members, manifest: agentVersions.manifest })
      .from(agents)
      .innerJoin(members, eq(members.id, agents.ownerId))
      .innerJoin(
        agentVersions,
        and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.publishedVersion)),
      )
      .where(and(eq(agents.id, agentId), publishedFor(memberId), sharedWith(memberId)));
    if (!row || row.owner.status !== 'active') return null;
    const manifest = agentManifestSchema.parse(JSON.parse(row.manifest));
    return {
      agent: withPublishedFace(row.agent, manifest),
      owner: row.owner,
      version: row.agent.publishedVersion!,
      manifest,
    };
  }

  /**
   * Whose memories a member may see: their own partition of their own Agents and of a public Agent
   * shared with them. Once it is no longer shared they can still read and forget what it kept.
   */
  async function memoryAgent(memberId: string, idOrHandle: string, write: boolean): Promise<AgentRow> {
    const own = await findOwn(memberId, idOrHandle);
    if (own) return own;
    const id = agentIdOf(idOrHandle);
    const usable = await shared(memberId, id);
    if (usable && !usable.agent.archivedAt) return usable.agent;
    if (!write) {
      const [kept] = await getDb()
        .select({ agent: agents })
        .from(agentMemories)
        .innerJoin(agents, eq(agents.id, agentMemories.agentId))
        .where(and(eq(agentMemories.agentId, id), eq(agentMemories.memberId, memberId)))
        .limit(1);
      if (kept) return kept.agent;
    }
    throw notFound('Agent');
  }

  /** The 发布 tab: the audience by name, and the settings. */
  async function publicationOf(row: AgentRow): Promise<Publication> {
    const db = getDb();
    const grants = await db
      .select()
      .from(shares)
      .where(and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, row.id)))
      .orderBy(asc(shares.createdAt), asc(shares.id));
    const memberIds = grants.filter((grant) => grant.principalType === 'member').map((grant) => grant.principalId!);
    const groupIds = grants.filter((grant) => grant.principalType === 'group').map((grant) => grant.principalId!);
    const [people, teams, [space]] = await Promise.all([
      memberIds.length
        ? db.select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, memberIds))
        : [],
      groupIds.length
        ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds))
        : [],
      db.select({ name: workspace.name }).from(workspace).limit(1),
    ]);
    const names = new Map([...people, ...teams].map((entry) => [entry.id, entry.name]));
    const published = row.visibility === 'public' && row.publishedVersion !== null;
    return {
      agent_id: row.id,
      published,
      version: row.publishedVersion,
      current_version: row.currentVersion,
      audience: grants.map((grant) => ({
        type: grant.principalType,
        id: grant.principalId,
        name:
          grant.principalType === 'workspace' ? (space?.name ?? 'Greenhouse') : (names.get(grant.principalId!) ?? ''),
      })),
      computer: published && row.publication.computer === true,
      daily_cap: published ? (row.publication.dailyCap ?? 0) : 0,
      paused_at: row.pausedAt,
    };
  }

  /** Active members who may talk to a public Agent, its owner not counted. */
  async function audienceSize(row: AgentRow): Promise<number> {
    const [result] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(members)
      .where(
        and(
          eq(members.status, 'active'),
          ne(members.id, row.ownerId),
          or(
            exists(
              getDb()
                .select({ one: sql`1` })
                .from(shares)
                .where(
                  and(
                    eq(shares.resourceType, 'agent'),
                    eq(shares.resourceId, row.id),
                    or(
                      eq(shares.principalType, 'workspace'),
                      and(eq(shares.principalType, 'member'), eq(shares.principalId, members.id)),
                    ),
                  ),
                ),
            ),
            exists(
              getDb()
                .select({ one: sql`1` })
                .from(shares)
                .innerJoin(groupMembers, eq(groupMembers.groupId, shares.principalId))
                .where(
                  and(
                    eq(shares.resourceType, 'agent'),
                    eq(shares.resourceId, row.id),
                    eq(shares.principalType, 'group'),
                    eq(groupMembers.memberId, members.id),
                  ),
                ),
            ),
          ),
        ),
      );
    return result?.n ?? 0;
  }

  /** The admin's view: no content, only who, how many and how much this month. */
  async function adminView(adminId: string, row: AgentRow, owner: Member, manifest: AgentManifest) {
    const month = currentMonth();
    const db = getDb();
    const byAudience = and(eq(usageEvents.agentId, row.id), ne(usageEvents.memberId, row.ownerId));
    const [[usage], [replies], size] = await Promise.all([
      db
        .select(totalsColumns)
        .from(usageEvents)
        .where(and(byAudience, gte(usageEvents.createdAt, month.start))),
      db
        .select({ turns: sql<number>`count(*)::int`, people: sql<number>`count(distinct ${runs.ownerId})::int` })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, row.id),
            eq(runs.kind, 'turn'),
            ne(runs.ownerId, row.ownerId),
            gte(runs.createdAt, month.start),
          ),
        ),
      audienceSize(row),
    ]);
    const view: AdminPublicAgent = {
      id: row.id,
      name: manifest.name,
      role: manifest.role,
      avatar: manifest.avatar,
      owner: summaryFor(deps.files, adminId)(owner),
      published_version: row.publishedVersion!,
      paused_at: row.pausedAt,
      audience_size: size,
      month: { ...toTotals(usage), turns: replies?.turns ?? 0, people: replies?.people ?? 0 },
    };
    return view;
  }

  /** A public Agent (not archived) for an admin. */
  async function publicRow(agentId: string) {
    const [row] = await getDb()
      .select({ agent: agents, owner: members, manifest: agentVersions.manifest })
      .from(agents)
      .innerJoin(members, eq(members.id, agents.ownerId))
      .innerJoin(
        agentVersions,
        and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.publishedVersion)),
      )
      .where(and(eq(agents.id, agentId), eq(agents.visibility, 'public'), isNull(agents.archivedAt)));
    if (!row) throw notFound('Public Agent');
    return { ...row, manifest: agentManifestSchema.parse(JSON.parse(row.manifest)) };
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

    /** Other members' public Agents shared with me: not paused, not archived, owner active. */
    async listPublic(memberId: string): Promise<PublicAgent[]> {
      const rows = await getDb()
        .select({ agent: agents, owner: members, manifest: agentVersions.manifest })
        .from(agents)
        .innerJoin(members, eq(members.id, agents.ownerId))
        .innerJoin(
          agentVersions,
          and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.publishedVersion)),
        )
        .where(
          and(
            publishedFor(memberId),
            eq(members.status, 'active'),
            isNull(agents.pausedAt),
            isNull(agents.archivedAt),
            sharedWith(memberId),
          ),
        )
        .orderBy(asc(agents.nameKey), asc(agents.id));
      const summary = summaryFor(deps.files, memberId);
      return rows.map((row) => {
        const manifest = agentManifestSchema.parse(JSON.parse(row.manifest));
        return {
          ...toAgent(withPublishedFace(row.agent, manifest), manifest),
          // Its audience talks to the published version and sees nothing of its owner's activity.
          current_version: row.agent.publishedVersion!,
          last_active_at: null,
          owner: summary(row.owner),
          daily_cap: row.agent.publication.dailyCap ?? 0,
        };
      });
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

    /** An Agent the member owns, archived ones included. */
    own: ownAgent,
    /** The same, or null. */
    findOwn,

    /**
     * What a turn for this asker runs on: their own Agent as `load` gives it, or someone else's
     * public Agent shared with them, on its published version. One that is no longer shared, or is
     * archived, answers agent_unavailable; one an admin paused, agent_paused.
     */
    async loadForTurn(askerId: string, agentId: string): Promise<TurnAgent> {
      const own = await findOwn(askerId, agentId);
      if (own) return { ...(await service.load(askerId, agentId)), public: null };
      const usable = await shared(askerId, agentIdOf(agentId));
      if (!usable || usable.agent.archivedAt) {
        throw conflict('agent_unavailable', 'This Agent is no longer shared with you.');
      }
      if (usable.agent.pausedAt) throw conflict('agent_paused', 'An admin paused this Agent.');
      return {
        agent: usable.agent,
        manifest: usable.manifest,
        version: usable.version,
        public: {
          ownerId: usable.owner.id,
          ownerName: usable.owner.name,
          computer: usable.agent.publication.computer === true,
          dailyCap: usable.agent.publication.dailyCap ?? 0,
        },
      };
    },

    /**
     * A public Agent shared with the member, for opening its thread: null when there is none for
     * them. Paused or archived ones are refused with their own code.
     */
    async openPublic(memberId: string, agentId: string): Promise<{ agent: AgentRow } | null> {
      const usable = await shared(memberId, agentIdOf(agentId));
      if (!usable) return null;
      if (usable.agent.archivedAt) throw conflict('agent_unavailable', 'This Agent is no longer shared with you.');
      if (usable.agent.pausedAt) throw conflict('agent_paused', 'An admin paused this Agent.');
      return { agent: usable.agent };
    },

    /** The faces of public Agents a member sees but does not own: their published name, role and avatar. */
    async publishedFaces(memberId: string, agentIds: string[]) {
      if (!agentIds.length) return new Map<string, { name: string; role: string; avatar: AgentAvatar }>();
      const rows = await getDb()
        .select({ id: agents.id, manifest: agentVersions.manifest })
        .from(agents)
        .innerJoin(
          agentVersions,
          and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.publishedVersion)),
        )
        .where(and(inArray(agents.id, agentIds), publishedFor(memberId)));
      return new Map(
        rows.map((row) => {
          const manifest = agentManifestSchema.parse(JSON.parse(row.manifest));
          return [row.id, { name: manifest.name, role: manifest.role, avatar: manifest.avatar }];
        }),
      );
    },

    async publication(memberId: string, idOrHandle: string): Promise<Publication> {
      return publicationOf(await ownAgent(memberId, idOrHandle));
    },

    /**
     * Publishes a version (default: the current one) to an audience, or changes the pin, the
     * audience or the settings of a published one. The audience is replaced as a whole. An admin's
     * pause stays until an admin resumes it.
     */
    async publish(memberId: string, idOrHandle: string, input: PublicationSave): Promise<Publication> {
      const row = await ownAgent(memberId, idOrHandle);
      if (row.isMain) throw conflict('agent_protected', 'Your main Agent cannot be published.');
      if (row.archivedAt) throw conflict('agent_archived', 'Restore this Agent before publishing it.');
      const version = input.version ?? row.currentVersion;
      if (version > row.currentVersion) throw notFound('Agent version');
      const manifest = await manifestOf(row.id, version);
      // Its audience runs it on the workspace's models: one only my own key reaches would serve nobody.
      if (!(await deps.providers.modelAvailable(manifest.model, { memberId, personal: false }))) {
        throw new ApiError(
          400,
          'model_not_shareable',
          'This version uses a model only your own key reaches. Choose a workspace model before publishing.',
        );
      }
      const key = (entry: { type: string; id?: string | undefined }) => `${entry.type}:${entry.id ?? ''}`;
      const audience = [...new Map(input.audience.map((entry) => [key(entry), entry])).values()].filter(
        (entry) => !(entry.type === 'member' && entry.id === memberId),
      );
      if (!audience.length) throw invalidInput('Choose who may use it besides you.');
      const memberIds = audience.filter((entry) => entry.type === 'member').map((entry) => entry.id!);
      const groupIds = audience.filter((entry) => entry.type === 'group').map((entry) => entry.id!);
      if (memberIds.length) {
        const active = await getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inArray(members.id, memberIds), eq(members.status, 'active')));
        if (active.length !== memberIds.length) throw invalidInput('Only active members can be in the audience.');
      }
      if (groupIds.length) {
        const known = await getDb().select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
        if (known.length !== groupIds.length) throw invalidInput('Some groups do not exist.');
      }
      const saved = await transaction(async (db) => {
        const [updated] = await db
          .update(agents)
          .set({
            visibility: 'public',
            publishedVersion: version,
            publication: { ...row.publication, computer: input.computer, dailyCap: input.daily_cap },
            updatedAt: sql`now()`,
          })
          .where(eq(agents.id, row.id))
          .returning();
        await db.delete(shares).where(and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, row.id)));
        await db.insert(shares).values(
          audience.map((entry) => ({
            id: newId('share'),
            resourceType: 'agent' as const,
            resourceId: row.id,
            principalType: entry.type,
            principalId: entry.type === 'workspace' ? null : entry.id!,
            role: 'user',
            createdBy: memberId,
          })),
        );
        // Publishing grants access to an Agent: recorded like any other grant.
        await audit({
          actorId: memberId,
          action: row.visibility === 'public' ? 'agent.republish' : 'agent.publish',
          resourceType: 'agent',
          resourceId: row.id,
          summary: changedFields(input),
        });
        return updated!;
      });
      return publicationOf(saved);
    },

    /** Back to private: its audience can no longer talk to it. Their threads and memories stay theirs. */
    async unpublish(memberId: string, idOrHandle: string): Promise<void> {
      const row = await ownAgent(memberId, idOrHandle);
      if (row.visibility !== 'public') return;
      await transaction(async (db) => {
        await db
          .update(agents)
          .set({ visibility: 'private', publishedVersion: null, publication: {}, updatedAt: sql`now()` })
          .where(eq(agents.id, row.id));
        await db.delete(shares).where(and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, row.id)));
        await audit({ actorId: memberId, action: 'agent.unpublish', resourceType: 'agent', resourceId: row.id });
      });
    },

    /** 管理 → 公开 Agents: every public Agent that is not archived, newest first. */
    async adminPublic(adminId: string, query: { cursor?: string; limit: number }): Promise<Page<AdminPublicAgent>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({ agent: agents, owner: members, manifest: agentVersions.manifest })
        .from(agents)
        .innerJoin(members, eq(members.id, agents.ownerId))
        .innerJoin(
          agentVersions,
          and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.publishedVersion)),
        )
        .where(
          and(eq(agents.visibility, 'public'), isNull(agents.archivedAt), before ? lt(agents.id, before) : undefined),
        )
        .orderBy(desc(agents.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = await Promise.all(
        page.map((row) =>
          adminView(adminId, row.agent, row.owner, agentManifestSchema.parse(JSON.parse(row.manifest))),
        ),
      );
      return { items, next_cursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!.agent.id) : null };
    },

    /** An admin stops (or lets again) a public Agent's audience talk to it; its owner is not affected. */
    async setPaused(adminId: string, agentId: string, paused: boolean): Promise<AdminPublicAgent> {
      return transaction(async (db) => {
        const found = await publicRow(agentId);
        const [updated] = await db
          .update(agents)
          .set({ pausedAt: paused ? (found.agent.pausedAt ?? sql`now()`) : null, updatedAt: sql`now()` })
          .where(eq(agents.id, agentId))
          .returning();
        if ((found.agent.pausedAt !== null) !== paused) {
          await audit({
            actorId: adminId,
            action: paused ? 'agent.pause' : 'agent.resume',
            resourceType: 'agent',
            resourceId: agentId,
          });
        }
        return adminView(adminId, updated!, found.owner, found.manifest);
      });
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

    /** What it remembers about me: my partition only, of my own Agents and of public ones I use. */
    async memories(memberId: string, idOrHandle: string, status: 'active' | 'all' = 'active'): Promise<AgentMemory[]> {
      const row = await memoryAgent(memberId, idOrHandle, false);
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
      const row = await memoryAgent(memberId, idOrHandle, true);
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
      const row = await memoryAgent(memberId, idOrHandle, false);
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
      const row = await memoryAgent(memberId, idOrHandle, false);
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
