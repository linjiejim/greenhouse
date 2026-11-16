import React from 'react';
import { useWindowDimensions } from 'react-native';
import { typo } from '../theme';
import { toolActivity, toolName } from './tool-words';
import type { ToolStep } from './parts';
import type { TFunction } from '../lib/i18n';
import { AssistantAvatar } from '../ui/avatar';
import { Controls } from '../ui/screen-actions.web';
import { useT } from '../lib/i18n';
import { useCopy } from '../ui/use-copy';
import { copyLabel } from '../ui/copy-state';
import { shareTextFile } from '../lib/share-file';
import { alertError } from '../ui/dialogs';
import type { MessageActions } from './messages';
import { WIDE_MIN } from '../shell/wide-model';
export function ReplyAvatar() {
  const { width } = useWindowDimensions();
  return width >= WIDE_MIN ? <AssistantAvatar size={24} /> : null;
}
export function ReplyActions({ text, actions, live }: { text: string; actions?: MessageActions; live: boolean }) {
  const t = useT();
  const { width } = useWindowDimensions();
  // the button answers (已复制 / 复制失败), never a notice
  const { state: copied, copy } = useCopy();
  if (live || !text || width < WIDE_MIN) return null;
  return (
    <Controls
      maxVisible={4}
      actions={[
        {
          id: 'copy',
          icon: copied === 'copied' ? 'check' : 'copy',
          label: copyLabel(copied, t('markdown.copy'), t),
          onPress: () => void copy(text),
        },
        ...(actions?.onRegenerate
          ? [
              {
                id: 'regenerate',
                icon: 'refresh' as const,
                label: t('conversation.regenerate'),
                onPress: actions.onRegenerate,
              },
            ]
          : []),
        ...(actions?.onBranch
          ? [
              {
                id: 'branch',
                icon: 'branch' as const,
                label: t('client.branch'),
                onPress: () => actions.onBranch?.(text),
              },
            ]
          : []),
        {
          id: 'export',
          icon: 'download',
          label: t('client.export'),
          onPress: () => {
            void shareTextFile('conversation.md', text, 'text/markdown;charset=utf-8').then((ok) => {
              if (!ok) alertError(t('common.error'));
            });
          },
        },
      ]}
    />
  );
}

export function replySummary(steps: readonly ToolStep[], running: string | null, t: TFunction) {
  const summary = toolActivity(steps, running, t);
  return summary && !running && steps.length && !steps.some((step) => step.status === 'running')
    ? `${summary} · ${toolName(steps[0]!.tool, t)}`
    : summary;
}
export function useMessageLayout() {
  const { width } = useWindowDimensions();
  return width >= WIDE_MIN
    ? { userText: typo.callout, authorName: typo.headline, showAgentName: true }
    : { userText: {}, authorName: {}, showAgentName: false };
}
