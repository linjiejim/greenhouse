import { Text, View } from 'react-native';
import type { TodoItem } from '../shared/contract';
import { useT } from '../lib/i18n';
import { useTheme, typo } from '../theme';

export function TodoPlan({ blocks = [], items }: { blocks?: unknown[]; items?: TodoItem[] }) {
  const t = useT();
  const { colors: c } = useTheme();
  const block = blocks.find(
    (b): b is { type: 'todo'; items: TodoItem[] } =>
      !!b && typeof b === 'object' && 'type' in b && b.type === 'todo' && 'items' in b && Array.isArray(b.items),
  );
  const plan = items ?? block?.items ?? [];
  if (!plan.length) return null;
  const words = {
    pending: t('integration.planPending'), active: t('integration.planActive'), done: t('integration.planDone'),
    blocked: t('integration.planBlocked'), skipped: t('integration.planSkipped'),
  };
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ ...typo.caption1, color: c.secondaryLabel }}>{t('integration.plan')}</Text>
      {plan.map((item, index) => (
        <Text key={index} style={{ ...typo.body, color: c.label }}>
          {item.status === 'done' ? '✓' : item.status === 'active' ? '◉' : '○'} {item.title} · {words[item.status]}
        </Text>
      ))}
    </View>
  );
}
