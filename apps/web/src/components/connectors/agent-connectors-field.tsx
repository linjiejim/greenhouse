/**
 * Which connectors an Agent may use through `mcp_call`: all of mine (null) or
 * only the ones ticked. It only narrows — a connector the member cannot use
 * stays out whatever is ticked. Renders nothing when the member has no
 * connectors (or no `mcp_call`).
 */

import React, { useEffect, useState } from 'react';
import { Checkbox } from '../ui';
import { FormGroup } from '../form';
import { useT } from '../../lib/i18n';
import { fetchMyConnectors } from '../../lib/api/connectors';

interface Option {
  id: string;
  name: string;
  handle: string;
}

export function AgentConnectorsField({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<Option[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMyConnectors()
      .then(({ team, personal }) => {
        if (cancelled) return;
        setOptions([...team, ...personal].map((c) => ({ id: c.id, name: c.name, handle: c.handle })));
      })
      .catch(() => setOptions([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!options || (options.length === 0 && value === null)) return null;
  const known = new Set(options.map((o) => o.id));
  const selected = value ?? [];

  return (
    <FormGroup label={t('connectors.agentField')} help={t('connectors.agentFieldHelp')}>
      <div className="space-y-1.5" data-testid="agent-connectors-field">
        <Checkbox
          label={t('connectors.agentAll')}
          checked={value === null}
          onChange={(e) => onChange(e.target.checked ? null : options.map((o) => o.id))}
        />
        {value !== null && (
          <div className="space-y-1 pl-6">
            {options.map((option) => (
              <Checkbox
                key={option.id}
                label={`${option.name} (${option.handle})`}
                checked={selected.includes(option.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))
                }
              />
            ))}
            {selected.some((id) => !known.has(id)) && (
              <p className="text-caption text-fg-faint">{t('connectors.agentGone')}</p>
            )}
          </div>
        )}
      </div>
    </FormGroup>
  );
}
