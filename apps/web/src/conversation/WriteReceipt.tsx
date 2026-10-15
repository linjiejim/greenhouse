import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, ChatCard } from '@greenhouse/ui/kit';
import type { Message } from '@greenhouse/contract';
import { useSession } from '../app/session';
import { useNotify } from '../app/notify';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';

export function WriteReceipt({ message }: { message: Message }) {
  const { t } = useI18n();
  const { me } = useSession();
  const notify = useNotify();
  const client = useQueryClient();
  const undo = useMutation({
    mutationFn: () => api.runs.undoWrite(String(message.event?.step_id)),
    onSuccess: () => {
      notify(t('approvals.undone'));
      void client.invalidateQueries({ queryKey: ['messages', message.conversation_id] });
    },
    onError: (error) => notify(errorText(error, t)),
  });
  const undone = undo.isSuccess || message.event?.undone === true;
  return (
    <ChatCard
      footerEnd
      title={t('approvals.receipt')}
      footer={
        message.event?.member_id === me?.id && (
          <Button disabled={undone} loading={undo.isPending} onClick={() => undo.mutate()}>
            {t(undone ? 'approvals.undone' : 'approvals.undo')}
          </Button>
        )
      }
    >
      <p className="app-detail-value">{message.content}</p>
    </ChatCard>
  );
}
