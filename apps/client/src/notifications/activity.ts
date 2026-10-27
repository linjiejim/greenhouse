/**
 * Team activity rows, React-free (./activity.test.ts): what a change says and what tapping it opens.
 *
 *  - Title: the object's name, else the server's action title, else the raw action.
 *  - Line: "<who> <verb>" (the agent's name in parentheses when an agent did it).
 *  - Tap: a run (agent write, automation …) opens its run sheet; otherwise the object's web route
 *    goes through the shared link handling (`useOpenHref`); nothing named → not tappable.
 */

import type { ActivityItem } from '../shared/greenhouse-types';
import type { ObjectRef } from '../shell/object-ref';

export type ActivityOpening = { ref: ObjectRef } | { href: string } | null;

export function activityOpening(item: ActivityItem): ActivityOpening {
  if (item.run?.id) return { ref: { kind: 'run', id: item.run.id } };
  const url = item.target?.url;
  return url ? { href: url } : null;
}

export function activityTitle(item: ActivityItem): string {
  return item.target?.label || (item.target?.id ? `#${item.target.id}` : null) || item.action_title || item.action;
}

export interface ActivityWords {
  /** Verb phrases by `ActivityItem.verb` ("updated", "更新了"). */
  verb: (verb: string) => string | null;
  someone: string;
}

export function activityLine(item: ActivityItem, words: ActivityWords): string {
  const who = item.actor.name || words.someone;
  const agent = item.agent ? ` (${item.agent.client_name})` : '';
  const verb = item.verb !== 'other' ? words.verb(item.verb) : null;
  return verb ? `${who}${agent} ${verb}` : `${who}${agent}`;
}
