/**
 * Usage and budgets (ADM-07, AGNT-15): my usage, the workspace's, one Agent's for its owner, and
 * the monthly budgets an admin sets. Everything is read from usage_events and runs: counts,
 * tokens and cost, never what anyone said. What a budget has spent comes from the same sum the
 * check before every call uses (providers/budgets.ts).
 */

import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AdminUsage,
  AgentActivity,
  AgentUsage,
  Budget,
  MyUsage,
  Page,
  UsagePeriod,
  UsageTotals,
  budgetInputSchema,
} from '@greenhouse/contract';
import {
  agents,
  budgets,
  getDb,
  members,
  messageFeedback,
  newId,
  runs,
  transaction,
  usageEvents,
  workspace,
  type BudgetRow,
  type Run,
} from '@greenhouse/db';
import type { z } from 'zod';
import { audit } from '../../audit.js';
import { invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import { currentMonth, spentOf, WORKSPACE_BUDGET_ID } from '../../providers/budgets.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AgentsService } from '../agents/service.js';
import { daysOf, periodOf, totalsColumns, toTotals } from './totals.js';

type BudgetSave = z.output<typeof budgetInputSchema>;

const MANAGED_SCOPES = ['workspace', 'provider', 'member'] as const;
const RECENT_COMMENTS = 20;

/** Most tokens first, then most calls. */
const byWeight = <T extends UsageTotals>(a: T, b: T) => b.tokens - a.tokens || b.requests - a.requests;

/** How runs ended, from (status, count) rows. */
function outcomes(rows: { status: Run['status']; n: number }[]) {
  const count = (statuses: Run['status'][]) =>
    rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.n, 0);
  return {
    total: count(['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled']),
    succeeded: count(['succeeded']),
    failed: count(['failed']),
    canceled: count(['canceled']),
    active: count(['queued', 'running', 'waiting']),
  };
}

export function createUsageService(deps: { agents: AgentsService; providers: ProvidersService }) {
  /** Totals grouped by one column over usage rows matching `where`. */
  async function grouped(column: AnyPgColumn, where: SQL | undefined) {
    const rows = await getDb()
      .select({ key: column, ...totalsColumns })
      .from(usageEvents)
      .where(where)
      .groupBy(column);
    return rows.map((row) => ({ key: row.key as string | null, totals: toTotals(row) }));
  }

  async function totalsOf(where: SQL | undefined): Promise<UsageTotals> {
    const [row] = await getDb().select(totalsColumns).from(usageEvents).where(where);
    return toTotals(row);
  }

  async function budgetViews(rows: BudgetRow[]): Promise<Budget[]> {
    if (!rows.length) return [];
    const month = currentMonth();
    const counting = await deps.providers.personalCounting();
    const memberIds = rows.filter((row) => row.scopeType === 'member').map((row) => row.scopeId);
    const [people, instances, [space]] = await Promise.all([
      memberIds.length
        ? getDb().select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, memberIds))
        : [],
      rows.some((row) => row.scopeType === 'provider') ? deps.providers.instanceDirectory() : new Map(),
      getDb().select({ name: workspace.name }).from(workspace).limit(1),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    return Promise.all(
      rows.map(async (row) => {
        const spent = await spentOf(row, counting, month);
        return {
          id: row.id,
          scope_type: row.scopeType as Budget['scope_type'],
          scope_id: row.scopeId,
          scope_name:
            row.scopeType === 'workspace'
              ? (space?.name ?? 'Greenhouse')
              : row.scopeType === 'member'
                ? (names.get(row.scopeId) ?? '')
                : (instances.get(row.scopeId)?.name ?? row.scopeId),
          unit: row.unit,
          monthly_limit: row.monthlyLimit,
          enabled: row.enabled,
          period_start: month.start,
          period_end: month.end,
          spent,
          exceeded: row.enabled && spent >= row.monthlyLimit,
          created_at: row.createdAt,
        };
      }),
    );
  }

  return {
    /** My usage, whoever's key served it, with my member budgets. */
    async mine(memberId: string, name: UsagePeriod['name']): Promise<MyUsage> {
      const period = periodOf(name);
      const where = and(eq(usageEvents.memberId, memberId), gte(usageEvents.createdAt, period.start));
      const day = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const [totals, capabilities, agentRows, dayRows, myBudgets] = await Promise.all([
        totalsOf(where),
        grouped(usageEvents.capability, where),
        grouped(usageEvents.agentId, where),
        getDb()
          .select({ day, ...totalsColumns })
          .from(usageEvents)
          .where(where)
          .groupBy(day),
        getDb()
          .select()
          .from(budgets)
          .where(and(eq(budgets.scopeType, 'member'), eq(budgets.scopeId, memberId), eq(budgets.enabled, true))),
      ]);
      const agentIds = agentRows.map((row) => row.key).filter((id): id is string => !!id);
      const [named, faces] = await Promise.all([
        agentIds.length
          ? getDb()
              .select({ id: agents.id, name: agents.name, ownerId: agents.ownerId })
              .from(agents)
              .where(inArray(agents.id, agentIds))
          : [],
        deps.agents.publishedFaces(memberId, agentIds),
      ]);
      // Someone else's Agent goes by the name its audience sees.
      const nameOf = (id: string) => {
        const row = named.find((entry) => entry.id === id);
        return (row && row.ownerId !== memberId ? faces.get(id)?.name : undefined) ?? row?.name ?? '';
      };
      const perDay = new Map(dayRows.map((row) => [row.day, toTotals(row)]));
      const counting = await deps.providers.personalCounting();
      return {
        period,
        totals,
        by_capability: capabilities.map((row) => ({ capability: row.key ?? '', ...row.totals })).sort(byWeight),
        by_agent: agentRows
          .map((row) => ({ agent_id: row.key, name: row.key ? nameOf(row.key) : '', ...row.totals }))
          .sort(byWeight),
        by_day: daysOf(period).map((date) => ({ day: date, ...(perDay.get(date) ?? toTotals(undefined)) })),
        budgets: await Promise.all(
          myBudgets.map(async (budget) => ({
            unit: budget.unit,
            monthly_limit: budget.monthlyLimit,
            spent: await spentOf(budget, counting),
          })),
        ),
      };
    },

    /** The workspace: every source, grouped by member, Agent, provider instance or capability. */
    async workspace(name: UsagePeriod['name'], groupBy: AdminUsage['group_by']): Promise<AdminUsage> {
      const period = periodOf(name);
      const where = and(gte(usageEvents.createdAt, period.start));
      const column = {
        member: usageEvents.memberId,
        agent: usageEvents.agentId,
        provider: usageEvents.providerId,
        capability: usageEvents.capability,
      }[groupBy];
      const [totals, rows] = await Promise.all([totalsOf(where), grouped(column, where)]);
      const keys = rows.map((row) => row.key).filter((key): key is string => !!key);
      const labels = new Map<string, { label: string; detail: string }>();
      if (groupBy === 'member' && keys.length) {
        const people = await getDb()
          .select({ id: members.id, name: members.name, email: members.email })
          .from(members)
          .where(inArray(members.id, keys));
        for (const person of people) labels.set(person.id, { label: person.name, detail: person.email });
      } else if (groupBy === 'agent' && keys.length) {
        const named = await getDb()
          .select({ id: agents.id, name: agents.name, owner: members.name })
          .from(agents)
          .innerJoin(members, eq(members.id, agents.ownerId))
          .where(inArray(agents.id, keys));
        for (const agent of named) labels.set(agent.id, { label: agent.name, detail: agent.owner });
      } else if (groupBy === 'provider') {
        for (const [id, instance] of await deps.providers.instanceDirectory()) {
          labels.set(id, { label: instance.name, detail: instance.capability });
        }
      }
      return {
        period,
        group_by: groupBy,
        totals,
        groups: rows
          .map((row) => ({
            key: row.key,
            label: (row.key && labels.get(row.key)?.label) || row.key || '',
            detail: (row.key && labels.get(row.key)?.detail) || '',
            ...row.totals,
          }))
          .sort(byWeight),
      };
    },

    async budgets(query: { cursor?: string; limit: number }): Promise<Page<Budget>> {
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(budgets)
        .where(and(inArray(budgets.scopeType, [...MANAGED_SCOPES]), after ? gt(budgets.id, after) : undefined))
        .orderBy(asc(budgets.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (row) => row);
      return { items: await budgetViews(page.items), next_cursor: page.next_cursor };
    },

    /** Creates or replaces the budget of one scope and unit. */
    async saveBudget(actorId: string, input: BudgetSave): Promise<Budget> {
      const scopeId = input.scope_type === 'workspace' ? WORKSPACE_BUDGET_ID : input.scope_id!;
      if (input.scope_type === 'provider' && !(await deps.providers.instanceDirectory()).get(scopeId)?.managed) {
        throw invalidInput('Budget a service instance of the workspace, not a personal key.');
      }
      if (input.scope_type === 'member') {
        const [member] = await getDb().select({ id: members.id }).from(members).where(eq(members.id, scopeId));
        if (!member) throw invalidInput('There is no such member.');
      }
      const row = await transaction(async (db) => {
        const [saved] = await db
          .insert(budgets)
          .values({
            id: newId('budget'),
            scopeType: input.scope_type,
            scopeId,
            unit: input.unit,
            monthlyLimit: input.monthly_limit,
            enabled: input.enabled,
          })
          .onConflictDoUpdate({
            target: [budgets.scopeType, budgets.scopeId, budgets.unit],
            set: { monthlyLimit: input.monthly_limit, enabled: input.enabled },
          })
          .returning();
        await audit({
          actorId,
          action: 'budget.save',
          resourceType: 'budget',
          resourceId: saved!.id,
          scopeType: input.scope_type,
          scopeId,
          summary: 'monthly_limit, enabled',
        });
        return saved!;
      });
      return (await budgetViews([row]))[0]!;
    },

    async removeBudget(actorId: string, id: string): Promise<void> {
      await transaction(async (db) => {
        const [deleted] = await db
          .delete(budgets)
          .where(and(eq(budgets.id, id), inArray(budgets.scopeType, [...MANAGED_SCOPES])))
          .returning();
        if (!deleted) throw notFound('Budget');
        await audit({
          actorId,
          action: 'budget.delete',
          resourceType: 'budget',
          resourceId: id,
          scopeType: deleted.scopeType,
          scopeId: deleted.scopeId,
        });
      });
    },

    /** One of my Agents: how much it was used and how replies were rated, never what was said. */
    async agentUsage(memberId: string, idOrHandle: string, name: UsagePeriod['name']): Promise<AgentUsage> {
      const agent = await deps.agents.own(memberId, idOrHandle);
      const period = periodOf(name);
      const db = getDb();
      const since = (column: typeof runs.createdAt) => gte(column, period.start);
      const [totals, runRows, [people], ratingRows, comments] = await Promise.all([
        totalsOf(and(eq(usageEvents.agentId, agent.id), gte(usageEvents.createdAt, period.start))),
        db
          .select({ kind: runs.kind, status: runs.status, n: sql<number>`count(*)::int` })
          .from(runs)
          .where(and(eq(runs.agentId, agent.id), since(runs.createdAt)))
          .groupBy(runs.kind, runs.status),
        db
          .select({ n: sql<number>`count(distinct ${runs.ownerId})::int` })
          .from(runs)
          .where(
            and(
              eq(runs.agentId, agent.id),
              eq(runs.kind, 'turn'),
              ne(runs.ownerId, agent.ownerId),
              since(runs.createdAt),
            ),
          ),
        db
          .select({ rating: messageFeedback.rating, n: sql<number>`count(*)::int` })
          .from(messageFeedback)
          .where(and(eq(messageFeedback.agentId, agent.id), gte(messageFeedback.createdAt, period.start)))
          .groupBy(messageFeedback.rating),
        db
          .select({
            rating: messageFeedback.rating,
            comment: messageFeedback.comment,
            version: messageFeedback.agentVersion,
            createdAt: messageFeedback.createdAt,
          })
          .from(messageFeedback)
          .where(
            and(
              eq(messageFeedback.agentId, agent.id),
              ne(messageFeedback.comment, ''),
              gte(messageFeedback.createdAt, period.start),
            ),
          )
          .orderBy(desc(messageFeedback.createdAt))
          .limit(RECENT_COMMENTS),
      ]);
      return {
        agent_id: agent.id,
        period,
        totals,
        turns: outcomes(runRows.filter((row) => row.kind === 'turn')),
        background_runs: outcomes(runRows.filter((row) => row.kind === 'background')),
        people: people?.n ?? 0,
        ratings: {
          up: ratingRows.find((row) => row.rating === 1)?.n ?? 0,
          down: ratingRows.find((row) => row.rating === -1)?.n ?? 0,
          comments: comments.map((row) => ({
            rating: row.rating,
            comment: row.comment,
            version: row.version,
            created_at: row.createdAt,
          })),
        },
      };
    },

    /** One of my Agents' runs, newest first: someone else's reply shows only its status and times. */
    async agentActivity(
      memberId: string,
      idOrHandle: string,
      query: { cursor?: string; limit: number },
    ): Promise<Page<AgentActivity>> {
      const agent = await deps.agents.own(memberId, idOrHandle);
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(runs)
        .where(and(eq(runs.agentId, agent.id), before ? lt(runs.id, before) : undefined))
        .orderBy(desc(runs.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, (run) => {
        const mine = run.ownerId === memberId;
        return {
          id: run.id,
          kind: run.kind,
          source: run.source,
          title: mine ? run.title : '',
          status: run.status,
          error_code: run.errorCode,
          mine,
          conversation_id: mine ? run.conversationId : null,
          started_at: run.startedAt,
          finished_at: run.finishedAt,
          created_at: run.createdAt,
        };
      });
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
