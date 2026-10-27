/** Browser list for official read surfaces without a dedicated screen: a place, not a pushed page. */
import React, { useCallback, useEffect } from 'react';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { Icon } from '../ui/core';
import { Place, PlaceEmpty } from '../ui/place.web';
import type { NativeScreenEntry } from './native-types';
import { resourceOf, type ResourceFact } from './resource-model';

const GOOD = new Set(['active', 'clean', 'enabled', 'connected', 'ready', 'running', 'published']);

export function ResourceScreen({ entry, title }: { entry: NativeScreenEntry; title: string }) {
  const t = useT();
  const resource = useResource(useCallback(() => get<Record<string, unknown>>(entry.endpoint!), [entry.endpoint]));
  useEffect(() => {
    const refresh = () => void resource.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const data = resource.data ? resourceOf(resource.data, entry.collection) : null;
  const value = (fact: ResourceFact) =>
    fact.value === null || fact.value === ''
      ? '—'
      : typeof fact.value === 'boolean'
        ? t(fact.value ? 'common.yes' : 'common.no')
        : String(fact.value);
  return (
    <Place
      title={title}
      actions={
        <button onClick={() => void resource.refresh()} disabled={resource.loading} aria-label={t('common.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      }
    >
      <div className="gh-place-scroll">
        {!data ? (
          <PlaceEmpty
            loading={resource.loading}
            error={resource.error ? resource.error.message || t('places.pluginError') : null}
            retry={resource.error?.status === 403 ? undefined : () => void resource.refresh()}
          />
        ) : data.kind === 'facts' ? (
          <section className="gh-resource-facts" data-testid="resource-facts">
            {data.facts.map((fact) => (
              <div key={fact.key}>
                <span>{fact.label}</span>
                <strong>{value(fact)}</strong>
              </div>
            ))}
          </section>
        ) : !data.rows.length ? (
          <PlaceEmpty icon={entry.icon} title={t('client.noItems')} />
        ) : (
          <ul className="gh-resource-list" data-testid="resource-list">
            {data.rows.map((row) => (
              <li key={row.id}>
                <span className="gh-resource-icon">
                  <Icon name={entry.icon} size={18} color="var(--gh-accent-text)" />
                </span>
                <div className="gh-resource-body">
                  <strong>{row.title}</strong>
                  {row.subtitle ? <p>{row.subtitle}</p> : null}
                  {row.tags.length ? (
                    <div className="gh-resource-tags">
                      {row.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="gh-resource-meta">
                  {row.status ? (
                    <span className="gh-resource-status" data-good={GOOD.has(row.status.toLowerCase()) || undefined}>
                      {row.status.charAt(0).toUpperCase() + row.status.slice(1)}
                    </span>
                  ) : null}
                  {row.time ? <small>{relativeTimeNow(row.time)}</small> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Place>
  );
}
