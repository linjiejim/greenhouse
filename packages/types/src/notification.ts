/** Shared wire types for the permanent platform notification center. */

import type { RuntimeJsonValue } from './runtime.js';

export type PlatformNotificationKind =
  | 'runtime_attention'
  | 'runtime_completed'
  | 'runtime_failed'
  | 'agent_review_due'
  | 'agent_suspended'
  | 'budget_attention'
  | 'system';

export interface PlatformNotification {
  id: string;
  user_id: string;
  kind: PlatformNotificationKind;
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
