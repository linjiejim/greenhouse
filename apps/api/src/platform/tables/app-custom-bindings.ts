/** Adapt a stored custom binding to the existing card evaluator and write planner. */
import { aggregateBindingCard, customBinding, type AppCard } from '@greenhouse/types/apps';

export function customBindingCard(card: Extract<AppCard, { kind: 'custom' }>, bindingId: unknown): AppCard | undefined {
  if (typeof bindingId !== 'string') return undefined;
  const binding = customBinding(card, bindingId);
  if (!binding) return undefined;
  const base = { id: card.id, layout: card.layout, title: card.title };
  if (binding.kind === 'aggregate') {
    const aggregate = aggregateBindingCard(binding);
    if (aggregate.kind === 'kpi') return { ...base, kind: 'kpi', card: aggregate };
    if (aggregate.kind === 'pivot') return { ...base, kind: 'pivot', card: aggregate };
    return undefined;
  }
  const actions = (card.actions ?? []).filter(
    (action) => action.bindingId === binding.id && action.do.type !== 'delete',
  );
  return {
    ...base,
    kind: 'records',
    source: binding.source,
    fieldIds: binding.fieldIds ?? [],
    actions,
    detail: { fieldIds: binding.fieldIds ?? [] },
    ...(card.create?.bindingId === binding.id ? { create: card.create } : {}),
  };
}
