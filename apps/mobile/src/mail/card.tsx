import { useRouter } from 'expo-router';
import { ListRow, ListSection } from '../ui/list';
import { useT } from '../lib/i18n';
import type { MessageItem } from '../shared/contract';
export function MailCard({ message }: { message: MessageItem }) {
  const router = useRouter();
  const t = useT();
  const event = message.event as {
    type?: string;
    mail_id?: string;
    subject?: string;
    from?: { name?: string | null; address?: string };
  } | null;
  if (event?.type !== 'mail' || !event.mail_id || !message.agent_id) return null;
  return (
    <ListSection>
      <ListRow
        title={event.subject || t('work.noSubject')}
        subtitle={event.from?.name || event.from?.address}
        icon="at"
        accessory="chevron"
        onPress={() =>
          router.push({ pathname: '/agents/mail', params: { id: message.agent_id!, mail: event.mail_id! } })
        }
      />
    </ListSection>
  );
}
