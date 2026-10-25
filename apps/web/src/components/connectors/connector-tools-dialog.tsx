/**
 * A connector's tools and their switches. Read-only tools are on by default;
 * writes are off until switched on (they then run directly); destructive
 * tools, when on, still show the member a preview first. A tool the server
 * does not mark read-only can be vouched for ("only reads"), which makes it a
 * read tool here.
 */

import React, { useState } from 'react';
import type { ConnectorToolView, ConnectorUpdate, ConnectorView } from '@greenhouse/types/connectors';
import { Button, Checkbox, Dialog, Spinner, Tag, Toggle } from '../ui';
import { FormActions, FormError } from '../form';
import { useT } from '../../lib/i18n';

const KIND_TONE = { read: 'success', write: 'warning', destructive: 'danger' } as const;

export function ConnectorToolsDialog({
  connector,
  canVouch,
  onClose,
  onSave,
}: {
  connector: ConnectorView;
  /** Admins vouch for team connectors; an owner for their own. */
  canVouch: boolean;
  onClose: () => void;
  onSave: (patch: ConnectorUpdate) => Promise<void>;
}) {
  const t = useT();
  const [tools, setTools] = useState<ConnectorToolView[]>(connector.tools);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (name: string, change: Partial<ConnectorToolView>) =>
    setTools((list) => list.map((tool) => (tool.name === name ? { ...tool, ...change } : tool)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        tool_policy: Object.fromEntries(tools.map((tool) => [tool.name, tool.enabled ? 'on' : 'off'])),
        vouched_read_only: tools.filter((tool) => tool.vouched).map((tool) => tool.name),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('connectors.toolsTitle', { name: connector.name })} size="lg">
      <div className="space-y-3" data-testid="connector-tools">
        <p className="text-xs text-fg-muted">{t('connectors.toolsHelp')}</p>
        {tools.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('connectors.noTools')}</p>
        ) : (
          <ul className="divide-y divide-edge rounded-lg border border-edge">
            {tools.map((tool) => {
              const kind = tool.read_only || tool.vouched ? 'read' : tool.destructive ? 'destructive' : 'write';
              return (
                <li key={tool.name} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-fg">{tool.name}</span>
                      <Tag tone={KIND_TONE[kind]}>{t(`connectors.kind.${kind}`)}</Tag>
                    </div>
                    {tool.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-fg-muted" title={tool.description}>
                        {tool.description}
                      </p>
                    )}
                    {canVouch && !tool.read_only && (
                      <div className="mt-1.5">
                        <Checkbox
                          label={t('connectors.vouch')}
                          checked={tool.vouched}
                          onChange={(e) =>
                            update(tool.name, {
                              vouched: e.target.checked,
                              // A vouched tool is a read: on unless switched off by hand.
                              ...(e.target.checked ? { enabled: true } : {}),
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                  <Toggle
                    size="sm"
                    checked={tool.enabled}
                    label={tool.name}
                    onChange={(checked) => update(tool.name, { enabled: checked })}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {error && <FormError>{error}</FormError>}
        <FormActions>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={saving || tools.length === 0} onClick={save} data-testid="connector-tools-save">
            {saving && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {t('common.save')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
