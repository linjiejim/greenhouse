import type { Tone } from '@greenhouse/ui/kit';
import type { RunView } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';

/** Run states in the words of content.md: yellow only while it needs you, red only on failure. */
export const RUN_STATUS: Record<RunView['status'], { word: MessageKey; tone: Tone }> = {
  queued: { word: 'status.queued', tone: 'info' },
  running: { word: 'status.running', tone: 'info' },
  waiting: { word: 'status.needsYou', tone: 'warning' },
  succeeded: { word: 'status.done', tone: 'success' },
  failed: { word: 'status.failed', tone: 'danger' },
  canceled: { word: 'status.canceled', tone: 'neutral' },
};

export const RUN_SOURCE: Record<RunView['source'], MessageKey> = {
  conversation: 'runs.fromConversation',
  schedule: 'runs.fromSchedule',
  automation: 'runs.fromAutomation',
  record: 'runs.fromRecord',
  handoff: 'runs.fromHandoff',
  app: 'runs.fromApp',
};

export const isActive = (run: Pick<RunView, 'status'>) =>
  run.status === 'queued' || run.status === 'running' || run.status === 'waiting';
