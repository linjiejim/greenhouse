/** Persistent coworker identities and bilateral conversations. Profiles own configuration. */
import { pgTable, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { sessions, messages } from './session.js';
import { agentWorkspaces } from './agent-run.js';

export const coworkers = pgTable(
  'coworkers',
  {
    id: text('id').primaryKey(),
    profile_key: text('profile_key').notNull(),
    owner_user_id: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [uniqueIndex('coworkers_identity').on(t.owner_user_id, t.profile_key)],
);

export const coworkerDialogues = pgTable(
  'coworker_dialogues',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    origin_session_id: text('origin_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    from_agent_id: text('from_agent_id')
      .notNull()
      .references(() => coworkers.id, { onDelete: 'cascade' }),
    to_agent_id: text('to_agent_id')
      .notNull()
      .references(() => coworkers.id, { onDelete: 'cascade' }),
    from_name: text('from_name').notNull(),
    to_name: text('to_name').notNull(),
    target_profile_id: text('target_profile_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [index('coworker_dialogues_origin').on(t.origin_session_id)],
);

export const coworkerRounds = pgTable(
  'coworker_rounds',
  {
    id: text('id').primaryKey(),
    dialogue_id: text('dialogue_id')
      .notNull()
      .references(() => coworkerDialogues.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    message: text('message').notNull(),
    reply: text('reply'),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    child_session_id: text('child_session_id'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [uniqueIndex('coworker_rounds_sequence').on(t.dialogue_id, t.round)],
);

export const coworkerWorkspaces = pgTable(
  'coworker_workspaces',
  {
    agent_instance_id: text('agent_instance_id')
      .notNull()
      .references(() => coworkers.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: integer('workspace_id')
      .notNull()
      .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('coworker_workspaces_identity').on(t.agent_instance_id, t.user_id)],
);

/** A private, stable entry point; transcripts remain in their original sessions. */
export const coworkerInboxes = pgTable(
  'coworker_inboxes',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent_instance_id: text('agent_instance_id')
      .notNull()
      .references(() => coworkers.id, { onDelete: 'cascade' }),
    active_session_id: text('active_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [uniqueIndex('coworker_inboxes_identity').on(t.user_id, t.agent_instance_id)],
);

/** Exact observed messages: editing an old topic cannot invalidate a sequence watermark. */
export const coworkerMessageReads = pgTable(
  'coworker_message_reads',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    message_id: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    content_hash: text('content_hash').notNull(),
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [uniqueIndex('coworker_message_reads_identity').on(t.user_id, t.message_id)],
);
