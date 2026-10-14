/**
 * A mail in an Agent's thread (AGNT-30): one that arrived at the Agent's address, or one it sent
 * once its owner approved. The card names who and what; opening it shows the mail in a drawer.
 * What the sender wrote is only ever shown as text here.
 */

import { Mail } from 'lucide-react';
import { Button, ChatCard } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Message } from '@greenhouse/contract';
import { useI18n } from '../lib/i18n';
import { useOpenOverlay } from '../shell/overlays';
import { MailDrawer } from './MailDrawer';

interface MailEvent {
  type: 'mail';
  mail_id: string;
  direction: 'in' | 'out';
  from?: { address: string; name: string | null };
  to?: { address: string; name: string | null }[];
  subject?: string;
  attachment_count?: number;
  verified?: boolean;
}

export const isMailEvent = (event: Message['event']): event is Message['event'] & MailEvent =>
  event?.type === 'mail' && typeof event.mail_id === 'string';

export function MailCard({ message }: { message: Message & { event: MailEvent } }) {
  const { t } = useI18n();
  const open = useOpenOverlay();
  const event = message.event;
  const from = event.from ? event.from.name || event.from.address : '';
  const to = (event.to ?? []).map((entry) => entry.address).join(', ');
  const count = event.attachment_count ?? 0;
  const meta = [
    event.direction === 'in' ? t('mail.cardIn', { from }) : t('mail.cardOut', { to }),
    ...(count ? [t('mail.attachmentCount', { count })] : []),
  ].join(' · ');
  return (
    <div className="app-mail-event" role="note">
      <ChatCard
        icon={<Mail size={icon.md} />}
        title={event.subject || t('mail.noSubject')}
        meta={meta}
        status={event.direction === 'out' ? t('mail.status.sent') : undefined}
        tone={event.direction === 'out' ? 'success' : undefined}
        footer={
          message.agent_id ? (
            <Button
              size="sm"
              onClick={() =>
                open({
                  type: 'custom',
                  render: (close) => <MailDrawer agentId={message.agent_id!} mailId={event.mail_id} onClose={close} />,
                })
              }
            >
              {t('mail.open')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
