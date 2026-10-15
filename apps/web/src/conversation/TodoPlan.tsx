import { todoItemSchema, type TodoItem } from '@greenhouse/contract';
import { ChatCard } from '@greenhouse/ui/kit';
import { useI18n } from '../lib/i18n';

export function TodoPlan({ blocks = [], items }: { blocks?: unknown[]; items?: TodoItem[] }) {
  const { t } = useI18n();
  const block = blocks.find(
    (b): b is { type: 'todo'; items: unknown[] } =>
      !!b && typeof b === 'object' && 'type' in b && b.type === 'todo' && 'items' in b && Array.isArray(b.items),
  );
  const plan =
    items ??
    block?.items.flatMap((item) => {
      const parsed = todoItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }) ??
    [];
  if (!plan.length) return null;
  return (
    <ChatCard title={t('message.plan')} expandable>
      <ol className="app-steps">
        {plan.map((item, i) => (
          <li className="app-step" key={i}>
            <span aria-hidden>{item.status === 'done' ? '✓' : item.status === 'active' ? '◉' : '○'}</span>
            <span className="app-step-summary">{item.title}</span>
            <span className="app-muted">{t(`plan.${item.status}`)}</span>
          </li>
        ))}
      </ol>
    </ChatCard>
  );
}
