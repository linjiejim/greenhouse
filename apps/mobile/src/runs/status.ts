/** Run states in the words of content.md: yellow only while it needs you, red only on failure. React-free. */

import type { RunView } from '../shared/contract';

export type RunTone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

export const RUN_STATUS: Record<RunView['status'], { word: string; tone: RunTone }> = {
  queued: { word: 'queued', tone: 'info' },
  running: { word: 'running', tone: 'info' },
  waiting: { word: 'needsYou', tone: 'warning' },
  succeeded: { word: 'done', tone: 'success' },
  failed: { word: 'failed', tone: 'danger' },
  canceled: { word: 'canceled', tone: 'neutral' },
};

export const RUN_SOURCE: Record<RunView['source'], string> = {
  conversation: 'fromConversation',
  schedule: 'fromSchedule',
  automation: 'fromAutomation',
  record: 'fromRecord',
  handoff: 'fromHandoff',
  app: 'fromApp',
};

export const isActiveRun = (run: Pick<RunView, 'status'>) =>
  run.status === 'queued' || run.status === 'running' || run.status === 'waiting';

/** "12.3s" under a minute, "4m" after. */
export const duration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`);
