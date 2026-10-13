import { Overlay } from '@greenhouse/ui/kit';
import { useT } from '../../lib/i18n';

/** New room: the people and Agents in it (M1.2). */
export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Overlay variant="dialog" title={t('chat.newRoom')} onClose={onClose}>
      {null}
    </Overlay>
  );
}
