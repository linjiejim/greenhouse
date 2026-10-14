import { useDraftNavigation } from './useDraftNavigation';
import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
  Overlay,
  OverlayActions,
  Select,
  TextArea,
} from '@greenhouse/ui/kit';
import { useAgents } from '../../data/agents';
import { useI18n } from '../../lib/i18n';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { tablesError } from './errors';

export function HandoffDialog({ recordId, onClose }: { recordId: string; onClose: () => void }) {
  const { t } = useI18n();
  const agents = useAgents();
  const [agentId, setAgentId] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nextRun, setNextRun] = useState<string | null>(null);
  const navigation = useDraftNavigation(!!brief.trim() && !nextRun, busy, onClose);
  useEffect(() => {
    if (nextRun) {
      onClose();
      navigate({ page: 'run', id: nextRun });
    }
  }, [nextRun, onClose]);
  return (
    <Overlay
      title={t('tables.handoff')}
      onClose={onClose}
      beforeClose={() => {
        if (busy) return false;
        if (!brief.trim()) return true;
        navigation.ask();
        return false;
      }}
    >
      <form
        id="record-handoff"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const run = await api.tables.automations.handoff(recordId, {
              agent_id: agentId || agents.items[0]!.id,
              brief,
            });
            setNextRun(run.run_id);
          } catch (failure) {
            setError(tablesError(failure, t));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="app-stack">
          <p className="app-muted">{t('tables.handoffHint')}</p>
          <FieldGroup label={t('tables.automation.agent')}>
            <Select
              label={t('tables.automation.agent')}
              value={agentId || agents.items[0]?.id || ''}
              options={agents.items.map((a) => ({ value: a.id, label: a.name }))}
              onChange={setAgentId}
            />
          </FieldGroup>
          <Field label={t('tables.automation.brief')}>
            <TextArea value={brief} maxLength={4000} onChange={(e) => setBrief(e.target.value)} required />
          </Field>
          {error && (
            <p role="alert" className="app-form-error">
              {error}
            </p>
          )}
        </div>
      </form>
      <OverlayActions>
        <Button disabled={busy} onClick={() => (brief.trim() ? navigation.ask() : onClose())}>
          {t('common.cancel')}
        </Button>
        <Button
          kind="primary"
          type="submit"
          form="record-handoff"
          disabled={busy || !brief.trim() || !agents.items.length}
        >
          {t('tables.handoffStart')}
        </Button>
      </OverlayActions>
      {navigation.asking && (
        <ConfirmDialog
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
