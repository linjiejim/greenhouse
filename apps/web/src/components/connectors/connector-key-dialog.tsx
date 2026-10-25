/**
 * Where a member pastes their own key for a per-member key connector. The
 * server stores it encrypted, tries it once and says whether it worked;
 * nothing is ever read back.
 */

import React, { useState } from 'react';
import { Button, Dialog, Input, Spinner, toast } from '../ui';
import { FormField } from '../form';
import { useT } from '../../lib/i18n';
import { saveConnectorKey, type KeyResult } from '../../lib/api/connectors';

export function ConnectorKeyDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: { id: string; name: string };
  onClose: () => void;
  onSaved: (result: KeyResult) => void;
}) {
  const t = useT();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveConnectorKey(connector.id, key.trim());
      if (result.ok) toast(t('connectors.keySaved', { name: connector.name }), 'success');
      else toast(t('connectors.keySavedButFailed', { error: result.error ?? '' }), 'error');
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('connectors.keyTitle', { name: connector.name })} size="md">
      <div className="space-y-3" data-testid="connector-key-dialog">
        <FormField
          label={t('connectors.keyLabel')}
          help={t('connectors.keyHelp', { name: connector.name })}
          error={error}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim() && !saving) void save();
            }}
            data-testid="connector-key-input"
          />
        </FormField>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!key.trim() || saving} onClick={save} data-testid="connector-key-save">
            {saving && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
