/**
 * The dialog where a member pastes their own key for a `per_user` connector.
 * The server verifies the key with one call before storing it encrypted
 * (PUT /api/connectors/:id/key); nothing is ever read back.
 */

import React, { useState } from 'react';
import type { McpConnectorView } from '@greenhouse/types/mcp-servers';
import { Button, Dialog, Input, Spinner, toast } from '../ui';
import { ExternalLink } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { saveConnectorKey } from '../../lib/api/connectors';

export function ConnectorKeyDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: Pick<McpConnectorView, 'id' | 'name' | 'credential_help' | 'credential_url'>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveConnectorKey(connector.id, key);
      toast(t('connectors.keySaved', { name: connector.name }), 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('connectors.keyTitle', { name: connector.name })} size="md">
      <div className="space-y-3" data-testid="connector-key-dialog">
        {connector.credential_help && <p className="text-sm text-fg-secondary">{connector.credential_help}</p>}
        {connector.credential_url && (
          <a
            href={connector.credential_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"
          >
            <ExternalLink size={12} />
            {t('connectors.getKey')}
          </a>
        )}
        <label className="block text-xs font-medium text-fg-muted" htmlFor="connector-key">
          {t('connectors.keyLabel')}
        </label>
        <Input
          id="connector-key"
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          placeholder={t('connectors.keyPlaceholder')}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim() && !saving) void save();
          }}
          data-testid="connector-key-input"
        />
        <p className="text-xs text-fg-muted">{t('connectors.keyHelp', { name: connector.name })}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('connectors.cancel')}
          </Button>
          <Button size="sm" disabled={!key.trim() || saving} onClick={save} data-testid="connector-key-save">
            {saving ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
            {saving ? t('connectors.saving') : t('connectors.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
