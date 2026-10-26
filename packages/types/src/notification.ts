/** Shared wire types for the permanent platform notification center. */

import type { RuntimeJsonValue } from './runtime.js';

export type PlatformNotificationKind =
  | 'runtime_attention'
  | 'runtime_completed'
  | 'runtime_failed'
  /** Historical only: the Agent governance worker that produced these was removed in v1.4. */
  | 'agent_review_due'
  | 'agent_suspended'
  | 'budget_attention'
  | 'system';

/** Known core vocabulary stays compatible with older clients; records also accept registered kinds. */
export type CoreNotificationKind = PlatformNotificationKind;
export type RegisteredNotificationKind = CoreNotificationKind | (string & {});
export const CORE_NOTIFICATION_KINDS: readonly CoreNotificationKind[] = [
  'runtime_attention',
  'runtime_completed',
  'runtime_failed',
  'agent_review_due',
  'agent_suspended',
  'budget_attention',
  'system',
];
let pluginKinds: readonly string[] = [];
let pluginChannels: readonly string[] = [];
export function registerNotificationKinds(kinds: readonly string[]): void {
  if (
    new Set(kinds).size !== kinds.length ||
    kinds.some((k) => CORE_NOTIFICATION_KINDS.includes(k as CoreNotificationKind))
  )
    throw new Error('Duplicate notification kind');
  pluginKinds = [...kinds];
}
export function registerNotificationChannels(channels: readonly string[]): void {
  pluginChannels = [...channels];
}
export function isNotificationKind(kind: string): boolean {
  return [...CORE_NOTIFICATION_KINDS, ...pluginKinds].includes(kind);
}
export function isNotificationChannel(channel: string): boolean {
  return ['desktop', 'mobile_push', ...pluginChannels].includes(channel);
}

export interface PlatformNotification {
  id: string;
  user_id: string;
  kind: RegisteredNotificationKind;
  title: string;
  body: string;
  payload: RuntimeJsonValue;
  run_id: string | null;
  interrupt_id: string | null;
  event_id: string | null;
  agent_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface PlatformNotificationList {
  notifications: PlatformNotification[];
  next_cursor: string | null;
}

export interface PlatformNotificationSummary {
  unread: number;
}
