import React from 'react';
import { useWindowDimensions } from 'react-native';
import { typo } from '../theme';
import { toolActivity, toolName } from './tool-words';
import type { ToolStep } from './parts';
import type { TFunction } from '../lib/i18n';
import * as Clipboard from 'expo-clipboard';
import { AssistantAvatar } from '../ui/avatar';
import { Controls } from '../ui/screen-actions.web';
import { useT } from '../lib/i18n';
import { toast } from '../ui/toast';
import { shareTextFile } from '../lib/share-file';
import { alertError } from '../ui/dialogs';
import type { MessageActions } from './messages';
export function ReplyAvatar() {
  const { width } = useWindowDimensions();
  return width >= 760 ? <AssistantAvatar size={24} /> : null;
}
export function ReplyActions({ text, actions, live }: { text: string; actions?: MessageActions; live: boolean }) {
  const t = useT();
  const { width } = useWindowDimensions();
  if (live || !text || width < 760) return null;
  return (
    <Controls
      maxVisible={4}
      actions={[
        {
          id: 'copy',
          icon: 'copy',
          label: t('markdown.copy'),
          onPress: () => {
            void Clipboard.setStringAsync(text);
            toast(t('markdown.copied'));
          },
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
  return width >= 760
    ? { userText: typo.callout, authorName: typo.headline, showAgentName: true }
    : { userText: {}, authorName: {}, showAgentName: false };
}
