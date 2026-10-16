import { eq, sql } from 'drizzle-orm';
import type { AdoptInput, Metrics, WeeklyMetric } from '@greenhouse/contract';
import { getDb, members, messages } from '@greenhouse/db';
import { forbidden, notFound, invalidInput } from '../../http/errors.js';
import type { FilesService } from '../files/service.js';
import type { ConversationsService } from '../conversations/service.js';
import { countAdoption, adoptedOutputKey } from './counts.js';

export function createMetricsService(deps: { files: FilesService; conversations: ConversationsService }) {
  return {
    async adopt(memberId: string, input: AdoptInput) {
      if (input.kind === 'download' && input.file_id) {
        const file = await deps.files.view(memberId, input.file_id);
        if (file.purpose !== 'artifact') throw invalidInput('Only Agent artifacts count as adopted outputs.');
        await countAdoption(memberId, adoptedOutputKey(file.run_id, 'file', file.id));
      } else {
        const [message] = await getDb()
          .select({ conversationId: messages.conversationId, role: messages.role, runId: messages.runId })
          .from(messages)
          .where(eq(messages.id, input.message_id!));
        if (!message || message.role !== 'assistant') throw notFound('Reply');
        await deps.conversations.access(memberId, message.conversationId);
        await countAdoption(memberId, adoptedOutputKey(message.runId, 'message', input.message_id!));
      }
    },
    async weekly(memberId: string, weeks: number): Promise<Metrics> {
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw invalidInput('Choose one to twelve weeks.');
      const [member] = await getDb()
        .select({ role: members.role, status: members.status })
        .from(members)
        .where(eq(members.id, memberId));
      if (member?.role !== 'admin' || member.status !== 'active')
        throw forbidden('Only admins can read workspace metrics.');
      const result = await getDb().execute(sql`
        with weeks as (
          select (date_trunc('week', now() at time zone 'UTC') at time zone 'UTC') - i * interval '1 week' as start
          from generate_series(0, ${weeks - 1}) i
        )
        select w.start as week_start, w.start + interval '1 week' as week_end,
          (select count(distinct member_id)::int from metric_events where kind in ('active','adopted') and created_at >= w.start and created_at < w.start + interval '1 week') as active_members,
          (select count(*)::int from metric_events where kind = 'adopted' and created_at >= w.start and created_at < w.start + interval '1 week') as adopted_outputs,
          (select count(*)::int from metric_events where kind = 'activated' and created_at >= w.start and created_at < w.start + interval '1 week') as new_members,
          (select count(*)::int from metric_events a where a.kind = 'activated' and a.created_at >= w.start and a.created_at < w.start + interval '1 week'
            and exists(select 1 from metric_events d where d.member_id = a.member_id and d.kind = 'adopted' and d.created_at >= a.created_at and d.created_at < a.created_at + interval '24 hours'
              and exists(select 1 from metric_events x where x.member_id = a.member_id and x.kind = 'assigned' and x.created_at >= a.created_at and x.created_at <= d.created_at))) as activated_members,
          (select percentile_cont(0.5) within group(order by extract(epoch from (decided_at-created_at))/60) from requests where decided_at >= w.start and decided_at < w.start + interval '1 week' and status in ('approved','rejected','answered','handed_back')) as decision_latency_minutes,
          (select count(*)::int from runs where kind = 'background' and finished_at >= w.start and finished_at < w.start + interval '1 week' and status in ('succeeded','failed','canceled')) as background_finished,
          (select count(*)::int from runs where kind = 'background' and finished_at >= w.start and finished_at < w.start + interval '1 week' and status = 'succeeded') as background_succeeded,
          (select count(*)::int from requests where created_at >= w.start and created_at < w.start + interval '1 week') as cards,
          (select percentile_cont(0.5) within group(order by card_count) from (
            select (select count(*) from requests r where r.member_id = a.member_id and (r.created_at at time zone 'UTC')::date = (a.created_at at time zone 'UTC')::date) as card_count
            from metric_events a where a.kind = 'active' and a.created_at >= w.start and a.created_at < w.start + interval '1 week'
          ) days) as cards_per_active_member_day,
          (select count(*) filter(where status='approved')::float / nullif(count(*),0) from requests where kind in ('approval','proposal','login') and status in ('approved','rejected') and decided_at >= w.start and decided_at < w.start + interval '1 week') as approval_rate,
          (select count(*) filter(where payload->>'tier'='tier3')::float / nullif(count(*),0) from requests where kind='approval' and created_at >= w.start and created_at < w.start + interval '1 week') as tier3_share,
          (select least(sum(coalesce(cached_tokens,0)),sum(coalesce(input_tokens,0)))::float / nullif(sum(coalesce(input_tokens,0)),0) from usage_events where capability='llm' and created_at >= w.start and created_at < w.start + interval '1 week') as cache_hit_rate,
          (select count(*)::int from runs where ((kind='turn' and input->>'reason'='event') or (kind='background' and input->>'event_woken'='true')) and created_at >= w.start and created_at < w.start + interval '1 week') as event_wakeups
        from weeks w order by w.start desc
      `);
      const numeric = (value: unknown) => (value === null || value === undefined ? null : Number(value));
      return {
        weeks: result.map((row) => {
          const active = Number(row.active_members);
          const adopted = Number(row.adopted_outputs);
          const joined = Number(row.new_members);
          const activated = Number(row.activated_members);
          const finished = Number(row.background_finished);
          const succeeded = Number(row.background_succeeded);
          return {
            week_start: new Date(String(row.week_start)).toISOString(),
            week_end: new Date(String(row.week_end)).toISOString(),
            active_members: active,
            adopted_outputs: adopted,
            adopted_per_active_member: active ? adopted / active : null,
            new_members: joined,
            activated_members: activated,
            activation_rate: joined ? activated / joined : null,
            decision_latency_minutes: numeric(row.decision_latency_minutes),
            background_finished: finished,
            background_succeeded: succeeded,
            background_success_rate: finished ? succeeded / finished : null,
            cards: Number(row.cards),
            cards_per_active_member_day: numeric(row.cards_per_active_member_day),
            approval_rate: numeric(row.approval_rate),
            tier3_share: numeric(row.tier3_share),
            cache_hit_rate: numeric(row.cache_hit_rate),
            event_wakeups: Number(row.event_wakeups),
          } satisfies WeeklyMetric;
        }),
      };
    },
  };
}
export type MetricsService = ReturnType<typeof createMetricsService>;
