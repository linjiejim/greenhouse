/**
 * The Bot's tool filter — "everything I may use" (null) or a checked subset
 * of the member's own allowed tools. A Bot can only narrow (the API intersects
 * the list with the owner's permissions again at run time), so the picker is
 * built from the same tool list the member sees everywhere else.
 */

import { useMemo, useState } from 'react';
import { Checkbox, Input, Tag } from '../ui';
import { getToolIcon } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { useProfileStore } from '../../stores';

const GROUP_LABELS: Record<'core' | 'team' | 'admin', TranslationKey> = {
  core: 'bots.form.toolGroupCore',
  team: 'bots.form.toolGroupTeam',
  admin: 'bots.form.toolGroupAdmin',
};

export function BotToolsField({
  value,
  onChange,
  compact = false,
}: {
  /** null = inherit the owner's whole allowed set. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  compact?: boolean;
}) {
  const t = useT();
  const availableTools = useProfileStore((state) => state.availableTools);
  const [search, setSearch] = useState('');
  const pickable = useMemo(() => availableTools.filter((tool) => !tool.builtin), [availableTools]);
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = query
      ? pickable.filter(
          (tool) =>
            tool.id.toLowerCase().includes(query) ||
            tool.name.toLowerCase().includes(query) ||
            tool.brief.toLowerCase().includes(query),
        )
      : pickable;
    return (['core', 'team', 'admin'] as const)
      .map((category) => ({ category, tools: matching.filter((tool) => tool.category === category) }))
      .filter((group) => group.tools.length > 0);
  }, [pickable, search]);

  const inherit = value === null;
  const selected = new Set(value ?? []);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div className="space-y-2" data-testid="bot-tools-field">
      <Checkbox
        label={t('bots.form.toolsInherit')}
        checked={inherit}
        onChange={(event) => onChange(event.target.checked ? null : pickable.map((tool) => tool.id))}
      />
      <p className="text-[11px] text-fg-faint">{t('bots.form.toolsHint')}</p>
      {!inherit && (
        <div className="rounded-lg border border-edge bg-surface-sunken/40">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('bots.form.filterTools')}
              size="sm"
            />
            <span className="flex-shrink-0 rounded-full bg-primary-subtle px-2 py-0.5 text-[10px] font-medium text-primary-fg-strong">
              {t('bots.form.toolsSelected', { count: selected.size })}
            </span>
          </div>
          <div className={`${compact ? 'max-h-40' : 'max-h-64'} overflow-y-auto`}>
            {groups.map((group) => (
              <div key={group.category}>
                <div className="sticky top-0 z-[1] border-b border-edge bg-surface-sunken px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                  {t(GROUP_LABELS[group.category])}
                </div>
                {group.tools.map((tool) => {
                  const Icon = getToolIcon(tool.id);
                  const checked = selected.has(tool.id);
                  return (
                    <label
                      key={tool.id}
                      className={`flex cursor-pointer items-start gap-2 border-b border-edge/60 px-3 py-2 transition-colors ${
                        checked ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
                      }`}
                    >
                      <Checkbox checked={checked} onChange={() => toggle(tool.id)} className="mt-0.5" />
                      <Icon size={14} className="mt-0.5 flex-shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
                          {tool.name}
                          {tool.surface?.proxy === 'write' && <Tag tone="danger">{t('bots.form.toolWrite')}</Tag>}
                        </span>
                        {tool.brief && <span className="block text-[11px] text-fg-muted">{tool.brief}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && <p className="px-3 py-3 text-xs text-fg-faint">{t('bots.form.noToolMatch')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
