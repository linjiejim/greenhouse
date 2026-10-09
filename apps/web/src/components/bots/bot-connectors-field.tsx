/**
 * The Bot's connector list (spec 20261009-mcp-connectors D9) — "every connector
 * I can use" (null) or a checked subset of the installed connectors. A list only
 * narrows: the Bot still calls each one with its owner's own connection, and
 * only when its tool list allows `mcp_call`.
 */

import { useEffect, useState } from 'react';
import type { McpConnectorView } from '@greenhouse/types/mcp-servers';
import { FormGroup } from '../form';
import { Checkbox, Tag } from '../ui';
import { useT } from '../../lib/i18n';
import { fetchMyConnectors } from '../../lib/api/connectors';

export function BotConnectorsField({
  value,
  onChange,
  toolsAllowMcp,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  toolsAllowMcp: boolean;
}) {
  const t = useT();
  const [connectors, setConnectors] = useState<McpConnectorView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMyConnectors()
      .then((result) => {
        if (!cancelled) setConnectors(result.enabled ? result.connectors : []);
      })
      .catch(() => {
        if (!cancelled) setConnectors([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to choose from (or no grant at all): say nothing rather than show a dead control.
  if (!connectors || connectors.length === 0) return null;

  const inherit = value === null;
  const selected = new Set(value ?? []);
  const toggle = (slug: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(slug);
    else next.delete(slug);
    onChange([...next]);
  };

  return (
    <FormGroup label={t('bots.form.connectors')}>
      <div className="space-y-2" data-testid="bot-connectors-field">
        <p className="text-xs text-fg-muted">{t('bots.form.connectorsHint')}</p>
        {!toolsAllowMcp && <p className="text-xs text-warning">{t('bots.form.connectorsNeedTool')}</p>}
        <Checkbox
          checked={inherit}
          onChange={(e) => onChange(e.target.checked ? null : connectors.map((c) => c.slug))}
          label={<span className="text-sm">{t('bots.form.connectorsAll')}</span>}
        />
        {!inherit && (
          <div className="space-y-1.5 pl-6">
            {connectors.map((connector) => (
              <Checkbox
                key={connector.id}
                checked={selected.has(connector.slug)}
                onChange={(e) => toggle(connector.slug, e.target.checked)}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-sm text-fg">{connector.name}</span>
                    <code className="text-[10px] text-fg-faint">{connector.slug}</code>
                    {connector.status === 'connected' && <Tag tone="success">{t('connectors.statusConnected')}</Tag>}
                    {connector.status === 'not_connected' && (
                      <Tag tone="neutral">{t('connectors.statusNotConnected')}</Tag>
                    )}
                  </span>
                }
              />
            ))}
            <p className="text-[11px] text-fg-faint">{t('bots.form.connectorsSelected', { count: selected.size })}</p>
          </div>
        )}
      </div>
    </FormGroup>
  );
}
