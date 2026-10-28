/**
 * The line under a conversation's title (React-free, ./header-words.test.ts): the agent's name,
 * and while a reply is written what it is doing now — thinking, the running tool in people's words
 * (./tool-words.ts), writing — then the name again.
 */

import type { TFunction } from '../lib/i18n';
import type { ToolStep } from './parts';
import { toolActivity } from './tool-words';

export interface ReplyNow {
  /** A reply is being written (or followed). */
  busy: boolean;
  /** The tool running now, if any. */
  tool: string | null;
  steps: readonly ToolStep[];
  /** The reply already has words on screen. */
  hasText: boolean;
}

export function headerSubtitle(agentName: string, now: ReplyNow | null, t: TFunction): string {
  if (!now?.busy) return agentName;
  const running = now.tool ?? [...now.steps].reverse().find((step) => step.status === 'running')?.tool ?? null;
  if (running) return toolActivity(now.steps, running, t) ?? t('conversation.subWorking');
  return now.hasText ? t('conversation.subWriting') : t('conversation.subThinking');
}
