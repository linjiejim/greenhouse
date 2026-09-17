import { sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { CoworkerInbox, CoworkerTopic, CoworkerActivity } from '@greenhouse/types/session';
import type { Db } from '../client.js';

// A single visible assistant message is one delivery. Internal peer turns and
// Runtime notification mirrors do not create additional chat unread counts.
const human = sql`s.channel not in ('subagent', 'workflow') and s.status not in ('deleted', 'eval')`;
const unread = sql`m.role = 'assistant' and not exists (
  select 1 from coworker_message_reads mr where mr.user_id = s.user_id
  and mr.message_id = m.id and mr.content_hash = md5(m.content || m.pipeline))`;
const active = sql`r.status in ('queued', 'claimed', 'running', 'waiting', 'paused')`;
const attention = sql`(exists (select 1 from runtime_interrupts ri
  where ri.run_id = r.id and ri.status = 'pending' and ri.assignee_user_id = r.owner_user_id)
  or (r.status in ('failed', 'interrupted') and exists (select 1 from notifications n
    where n.run_id = r.id and n.user_id = r.owner_user_id and n.read_at is null)))`;

export function createCoworkerInboxService(db: Db) {
  return {
    async savedTopic(userId: string, agentId: string) {
      const rows = await db.execute(sql`select active_session_id from coworker_inboxes
        where user_id = ${userId} and agent_instance_id = ${agentId}`);
      return rows[0] as { active_session_id: string | null } | undefined;
    },
    async listInboxes(userId: string, includeWorkflow = false): Promise<CoworkerInbox[]> {
      const rows = await db.execute(sql`
        select c.id, c.profile_key as profile_id, c.name, i.active_session_id,
          (select m.session_id from messages m join sessions s on s.id = m.session_id
            where s.user_id = ${userId} and s.agent_instance_id = c.id and ${human} and ${unread}
            order by m.created_at, m.id limit 1) as first_unread_session_id,
          (select m.id from messages m join sessions s on s.id = m.session_id
            where s.user_id = ${userId} and s.agent_instance_id = c.id and ${human} and ${unread}
            order by m.created_at, m.id limit 1) as first_unread_message_id,
          (select count(*)::int from sessions s where s.user_id = ${userId}
            and s.agent_instance_id = c.id and ${human}) as topic_count,
          (select count(*)::int from messages m join sessions s on s.id = m.session_id
            where s.user_id = ${userId} and s.agent_instance_id = c.id and ${human} and ${unread}) as unread_count,
          (select count(*)::int from runtime_runs r join sessions s on s.id = r.session_id
            where s.agent_instance_id = c.id and s.user_id = ${userId} and r.owner_user_id = ${userId}
            and (${includeWorkflow} or r.kind != 'workflow') and ${active}) as running_count,
          (select count(*)::int from runtime_runs r join sessions s on s.id = r.session_id
            where s.agent_instance_id = c.id and s.user_id = ${userId} and r.owner_user_id = ${userId}
            and (${includeWorkflow} or r.kind != 'workflow') and ${attention}) as attention_count
        from coworkers c left join coworker_inboxes i on i.agent_instance_id = c.id and i.user_id = ${userId}
        where c.owner_user_id = ${userId} or i.user_id is not null or exists
          (select 1 from sessions s where s.agent_instance_id = c.id and s.user_id = ${userId})
        order by c.created_at, c.id`);
      return Array.from(rows) as unknown as CoworkerInbox[];
    },
    async rememberTopic(userId: string, agentId: string, sessionId: string | null) {
      if (sessionId) {
        const rows = await db.execute(sql`select s.id from sessions s where s.id = ${sessionId}
          and s.user_id = ${userId} and s.agent_instance_id = ${agentId} and ${human}`);
        if (!rows.length) throw new Error('Topic not found');
      }
      await db.execute(sql`insert into coworker_inboxes (user_id, agent_instance_id, active_session_id, updated_at)
        values (${userId}, ${agentId}, ${sessionId}, ${nowIso()})
        on conflict (user_id, agent_instance_id) do update
        set active_session_id = excluded.active_session_id, updated_at = excluded.updated_at`);
    },
    async listTopics(
      userId: string,
      agentId: string,
      options: {
        before?: { updated_at: string; id: string };
        limit?: number;
        includeWorkflow?: boolean;
      } = {},
    ): Promise<CoworkerTopic[]> {
      const rows = await db.execute(sql`
        select s.id, s.title, s.profile_id, s.updated_at,
          coalesce((select left(m.content, 180) from messages m where m.session_id = s.id
            order by m.seq desc limit 1), '') as preview,
          (select count(*)::int from messages m where m.session_id = s.id and ${unread}) as unread_count,
          (select m.id from messages m where m.session_id = s.id and ${unread} order by m.seq limit 1) as first_unread_id,
          (select count(*)::int from runtime_runs r where r.session_id = s.id and r.owner_user_id = ${userId}
            and (${!!options.includeWorkflow} or r.kind != 'workflow') and ${active}) as running_count,
          (select count(*)::int from runtime_runs r where r.session_id = s.id and r.owner_user_id = ${userId}
            and (${!!options.includeWorkflow} or r.kind != 'workflow') and ${attention}) as attention_count
        from sessions s where s.user_id = ${userId} and s.agent_instance_id = ${agentId} and ${human}
        ${options.before ? sql`and (s.updated_at, s.id) < (${options.before.updated_at}::timestamptz, ${options.before.id})` : sql``}
        order by s.updated_at desc, s.id desc limit ${Math.min(options.limit ?? 30, 100)}`);
      return Array.from(rows).map((row) => ({
        ...row,
        updated_at: new Date(row.updated_at as string).toISOString(),
      })) as CoworkerTopic[];
    },
    async inboxActivities(userId: string, agentId: string, includeWorkflow = false): Promise<CoworkerActivity[]> {
      const rows = await db.execute(sql`
        select r.id, case when s.channel in ('subagent', 'workflow')
          then coalesce(s.parent_session_id, s.id) else s.id end as session_id, r.kind, r.status, s.title,
          ${attention} as attention
        from runtime_runs r join sessions s on s.id = r.session_id
        where r.owner_user_id = ${userId} and s.user_id = ${userId} and s.agent_instance_id = ${agentId}
          and (${includeWorkflow} or r.kind != 'workflow') and (${active} or ${attention})
        order by r.updated_at desc, r.id desc limit 30`);
      return Array.from(rows) as unknown as CoworkerActivity[];
    },
    async markMessagesRead(userId: string, sessionId: string, messageIds: string[]) {
      if (!messageIds.length) return;
      // Exact IDs from rendered messages, not a client timestamp or "read all".
      // The owner check lives in the write itself as well as in the route.
      await db.execute(sql`insert into coworker_message_reads (user_id, message_id, content_hash, read_at)
        select ${userId}, m.id, md5(m.content || m.pipeline), ${nowIso()}::timestamptz
        from messages m join sessions s on s.id = m.session_id
        where s.id = ${sessionId} and s.user_id = ${userId} and ${human}
          and m.role = 'assistant' and m.id in (${sql.join(
            messageIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        on conflict (user_id, message_id) do update set content_hash = excluded.content_hash, read_at = excluded.read_at`);
    },
  };
}
