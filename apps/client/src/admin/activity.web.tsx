/**
 * Activity log (GET /api/activity, super: everyone's): changes by people, members' agents,
 * automations and administrators, newest first. Filters: source, module, person, date range;
 * cursor pages ("Load more"); CSV export with the same filters (/api/activity/export). A row opens
 * its object, or its run, the shared way (src/notifications/activity.ts rules).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, queryString } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useResource } from '../data/use-resource';
import { useStationManifest } from '../plugins/store';
import { localize } from '../shared/plugins';
import type { ActivityItem } from '../shared/greenhouse-types';
import { usePrefs } from '../store/prefs';
import { useT, localeOf, type TranslationKey } from '../lib/i18n';
import { useOpenHref, useOpenObject } from '../shell/open-object';
import { activityLine, activityOpening, activityTitle } from '../notifications/activity';
import { Icon, type IconName } from '../ui/core';
import { alertError } from '../ui/dialogs';
import * as admin from './api';
import { AdminPage, Badge, SectionState, type Tone } from './kit.web';
import { dateTimeLabel } from './format';

const SOURCES = ['person', 'agent', 'automation', 'admin'] as const;
const MODULES = [
  'knowledge',
  'files',
  'projects',
  'tables',
  'skills',
  'feedback',
  'automations',
  'settings',
  'users',
  'mcp',
  'connectors',
] as const;
const SOURCE_ICON: Record<string, IconName> = {
  person: 'person',
  agent: 'sparkle',
  automation: 'clock',
  admin: 'shieldCheck',
};
const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  outcome_unknown: 'warning',
};

/** A date input (YYYY-MM-DD) as the start / the end of that local day, in ISO. */
const dayStart = (value: string) => (value ? new Date(`${value}T00:00:00`).toISOString() : undefined);
const dayEnd = (value: string) =>
  value ? new Date(new Date(`${value}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined;

/** The log's rows also carry the run status (packages/types/src/activity.ts). */
type LogItem = ActivityItem & { status?: string | null };
interface Page {
  items: LogItem[];
  next_cursor: string | null;
}

export default function ActivitySection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const openObject = useOpenObject();
  const openHref = useOpenHref();
  const people = useResource(useCallback(() => admin.listUsers(), []));
  const [source, setSource] = useState('');
  const [module, setModule] = useState('');
  const [person, setPerson] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [items, setItems] = useState<LogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'more' | 'ready' | { status: number; message: string }>('loading');
  const generation = useRef(0);
  const query = useMemo(
    () => ({
      source: source || undefined,
      module: module || undefined,
      user_id: person || undefined,
      from: dayStart(range.from),
      to: dayEnd(range.to),
    }),
    [source, module, person, range],
  );
  const load = useCallback(
    async (after: string | null) => {
      const n = ++generation.current;
      const current = captureIdentity();
      setState(after ? 'more' : 'loading');
      const page = await get<Page>('/api/activity', { ...query, cursor: after ?? undefined });
      if (n !== generation.current || !current()) return;
      if (!page.ok) {
        setState({ status: page.status, message: page.message });
        return;
      }
      setItems((list) => {
        if (!after) return page.data.items;
        const known = new Set(list.map((item) => item.id));
        return [...list, ...page.data.items.filter((item) => !known.has(item.id))];
      });
      setCursor(page.data.next_cursor);
      setState('ready');
    },
    [query],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const exportCsv = async () => {
    try {
      const res = await api(`/api/activity/export${queryString(query)}`);
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'activity.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      alertError(t('admin.activity.exportFailed'), error instanceof Error ? error.message : undefined);
    }
  };
  const moduleLabel = (key: string) => {
    if ((MODULES as readonly string[]).includes(key)) return t(`admin.activity.module.${key}` as TranslationKey);
    const plugin = manifest.kind === 'v2' ? manifest.manifest.plugins.find((p) => p.id === key) : undefined;
    return plugin ? localize(plugin.name, lang) : key;
  };
  const words = {
    someone: t('notifications.someone'),
    verb: (verb: string) => {
      const key = `notifications.verb.${verb}`;
      const value = t(key as TranslationKey);
      return value === key ? null : value;
    },
  };
  const failed = typeof state === 'object' ? state : null;
  return (
    <AdminPage
      title={t('admin.sections.activity')}
      testID="admin-activity"
      actions={
        <>
          <button
            className="gh-icon-button"
            aria-label={t('common.refresh')}
            disabled={state === 'loading'}
            onClick={() => void load(null)}
          >
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-admin-button" onClick={() => void exportCsv()}>
            <Icon name="download" size={14} />
            {t('admin.activity.export')}
          </button>
        </>
      }
      toolbar={
        <>
          <select aria-label={t('admin.activity.source')} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t('admin.activity.allSources')}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`admin.activity.sources.${s}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={t('admin.activity.moduleLabel')}
            value={module}
            onChange={(e) => setModule(e.target.value)}
          >
            <option value="">{t('admin.activity.allModules')}</option>
            {MODULES.map((m) => (
              <option key={m} value={m}>
                {moduleLabel(m)}
              </option>
            ))}
          </select>
          <select aria-label={t('admin.activity.person')} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{t('admin.activity.everyone')}</option>
            {(people.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.nickname}
              </option>
            ))}
          </select>
          <input
            type="date"
            aria-label={t('admin.activity.from')}
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
          <span className="gh-admin-count" style={{ marginLeft: 0 }}>
            –
          </span>
          <input
            type="date"
            aria-label={t('admin.activity.to')}
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </>
      }
    >
      {items.length ? (
        <table className="gh-data-grid gh-admin-grid" data-testid="admin-activity-list">
          <thead>
            <tr>
              <th>{t('admin.activity.when')}</th>
              <th>{t('admin.activity.who')}</th>
              <th>{t('admin.activity.what')}</th>
              <th>{t('admin.activity.moduleLabel')}</th>
              <th>{t('admin.metering.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const opening = activityOpening(item);
              const open = opening
                ? () => ('ref' in opening ? openObject(opening.ref) : openHref(opening.href))
                : undefined;
              return (
                <tr
                  key={item.id}
                  data-open={open ? '' : undefined}
                  tabIndex={open ? 0 : undefined}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (open && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      open();
                    }
                  }}
                >
                  <td>{dateTimeLabel(item.at, localeOf(lang))}</td>
                  <td>
                    <span className="gh-admin-person">
                      <Icon name={SOURCE_ICON[item.source] ?? 'person'} size={14} />
                      {activityLine(item, words)}
                    </span>
                  </td>
                  <td
                    title={item.detail ?? undefined}
                    style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {activityTitle(item)}
                  </td>
                  <td>{moduleLabel(item.module)}</td>
                  <td>
                    {item.status ? (
                      <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                        {t(`admin.activity.status.${item.status}` as TranslationKey)}
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {items.length && cursor ? (
        <button className="gh-admin-button" disabled={state === 'more'} onClick={() => void load(cursor)}>
          {state === 'more' ? t('common.loading') : t('admin.activity.loadMore')}
        </button>
      ) : null}
      {!items.length ? (
        <SectionState
          loading={state === 'loading'}
          error={failed}
          retry={() => void load(null)}
          icon="runs"
          title={t('admin.activity.empty')}
          message={t('admin.activity.emptyHint')}
        />
      ) : null}
    </AdminPage>
  );
}
