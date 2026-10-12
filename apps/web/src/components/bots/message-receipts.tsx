import type { BotMessage, BotView } from '@greenhouse/types/bots';
import type { ConversationReceipts } from '../../lib/api/bots';
import { useT } from '../../lib/i18n';

export function MessageReceipts({
  message,
  receipts,
  me,
  lookup,
}: {
  message: BotMessage;
  receipts: ConversationReceipts;
  me: string | null;
  lookup: (id: string | null | undefined) => BotView | undefined | null;
}) {
  const t = useT();
  const people = receipts.people.filter((p) => p.user_id !== me && p.through_seq >= message.seq);
  const agents = receipts.agents.filter((r) => r.message_id === message.id);
  if (!people.length && !agents.length) return null;
  const processed = agents.filter((r) => r.processed_at !== null).length;
  return (
    <details className="relative mt-0.5 text-right text-[10px] text-fg-faint" data-testid="message-read-receipt">
      <summary className="inline cursor-pointer list-none hover:text-fg-secondary">
        {[
          people.length ? t('bots.room.readBy', { count: String(people.length) }) : '',
          agents.length ? t('bots.room.agentsRead', { read: String(processed), total: String(agents.length) }) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-edge bg-surface-raised p-2 text-left text-xs shadow-lg">
        {people.map((person) => (
          <div key={person.user_id} className="py-0.5">
            {person.nickname} · {t('bots.room.receiptRead')}
          </div>
        ))}
        {agents.map((agent) => (
          <div key={agent.bot_id} className="py-0.5">
            {lookup(agent.bot_id)?.name ?? t('bots.deletedBot')} · {t(`bots.room.receipt.${agent.status}`)}
          </div>
        ))}
      </div>
    </details>
  );
}
