import { useRef } from 'react';
import { ConfirmDialog } from '@greenhouse/ui/kit';
import { useDraftNavigation } from './useDraftNavigation';
import { useT } from './i18n';

/** Forms share the same dismissal and navigation guard; saving still closes directly. */
export function useOverlayDraft(value: unknown, busy: boolean, onClose: () => void) {
  const t = useT();
  const initial = useRef(JSON.stringify(value));
  const dirty = JSON.stringify(value) !== initial.current;
  const navigation = useDraftNavigation(dirty, busy, onClose);
  return {
    formProps: { inert: busy, 'aria-busy': busy },
    saved() {
      navigation.saved();
      onClose();
    },
    beforeClose() {
      if (busy) return false;
      if (!dirty) return true;
      navigation.ask();
      return false;
    },
    close() {
      if (busy) return;
      if (dirty) navigation.ask();
      else onClose();
    },
    confirmation: navigation.asking ? (
      <ConfirmDialog
        title={t('knowledge.discardTitle')}
        confirmLabel={t('knowledge.discard')}
        onCancel={navigation.cancel}
        onConfirm={navigation.discard}
      >
        {t('knowledge.discardBody')}
      </ConfirmDialog>
    ) : null,
  };
}
