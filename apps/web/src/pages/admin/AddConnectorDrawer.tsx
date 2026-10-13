/**
 * 添加连接器 (ADM-08): from the built-in catalog (checked against the live servers), from the
 * official MCP Registry (slow and unvetted: a result fills the address form, or points at the
 * catalog entry for the same server), or from an address, probed first to fill in the auth mode.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  Input,
  Overlay,
  OverlayActions,
  SearchInput,
  Skeleton,
  Tabs,
} from '@greenhouse/ui/kit';
import type { CatalogEntry, Connector, ProbeResult, RegistryResult } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { connectorKeys, useConnectorCatalog } from '../../data/connectors';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n, type Translate } from '../../lib/i18n';
import { blankDraft, createInput, draftProblem, slugFrom, type ConnectorDraft } from './connector-draft';
import { ConnectorFields, MODE_LABEL, TransportField, type DraftError } from './ConnectorFields';

type Source = 'catalog' | 'registry' | 'url';
const SOURCES: Source[] = ['catalog', 'registry', 'url'];
const SOURCE_LABEL: Record<Source, MessageKey> = {
  catalog: 'connectors.fromCatalog',
  registry: 'connectors.fromRegistry',
  url: 'connectors.fromUrl',
};
const VERIFIED: Record<CatalogEntry['verification']['level'], MessageKey> = {
  call: 'connectors.verified.call',
  sign_in: 'connectors.verified.sign_in',
  handshake: 'connectors.verified.handshake',
};

/** An install failed: say why in words, and offer another slug when this one is taken. */
function installProblem(caught: unknown, t: Translate): string {
  return caught instanceof ApiClientError && caught.code === 'connector_slug_taken'
    ? t('connectors.slugTaken')
    : errorText(caught, t);
}

function useInstalled(onInstalled: (connector: Connector) => void) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  return async (connector: Connector) => {
    await client.invalidateQueries({ queryKey: connectorKeys.admin });
    void client.invalidateQueries({ queryKey: connectorKeys.mine });
    notify(t('connectors.installed', { name: connector.name }));
    onInstalled(connector);
  };
}

function CatalogTab({ focus, onInstalled }: { focus: string | null; onInstalled: (connector: Connector) => void }) {
  const { t, locale } = useI18n();
  const catalog = useConnectorCatalog();
  const installed = useInstalled(onInstalled);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string; slug: string } | null>(null);
  const zh = locale === 'zh';
  const titleOf = (entry: CatalogEntry) => (zh ? (entry.title_zh ?? entry.title) : entry.title);
  const descriptionOf = (entry: CatalogEntry) => (zh ? entry.description_zh : entry.description);

  // From a Registry result that the catalog has: show just that entry.
  useEffect(() => {
    const entry = focus ? catalog.data?.items.find((item) => item.id === focus) : undefined;
    if (entry) setQuery(entry.id);
  }, [focus, catalog.data]);

  const install = async (entry: CatalogEntry, slug?: string) => {
    setBusy(entry.id);
    setFailed(null);
    try {
      await installed(await api.admin.connectors.create({ catalog_id: entry.id, ...(slug ? { slug } : {}) }));
    } catch (caught) {
      setBusy(null);
      setFailed({ id: entry.id, text: installProblem(caught, t), slug: slug ?? `${entry.slug}-2` });
    }
  };

  if (catalog.isPending) return <Skeleton lines={6} />;
  if (catalog.isError) return <ErrorBox onRetry={() => void catalog.refetch()}>{t('common.error')}</ErrorBox>;
  const needle = query.trim().toLowerCase();
  const entries = catalog.data.items.filter(
    (entry) =>
      !needle ||
      [entry.id, entry.title, entry.title_zh ?? '', descriptionOf(entry)].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  );
  return (
    <div className="app-section">
      <SearchInput value={query} onChange={setQuery} label={t('connectors.searchCatalog')} />
      {entries.length ? (
        <ul className="app-list">
          {entries.map((entry) => (
            <li key={entry.id} className="app-list-row is-static">
              <span className="app-list-main">
                <span className="app-list-title">{titleOf(entry)}</span>
                <span className="app-muted">{descriptionOf(entry)}</span>
                <span className="app-list-meta">
                  {t(MODE_LABEL[entry.auth.mode])} · {t(VERIFIED[entry.verification.level])}
                </span>
                {failed?.id === entry.id && (
                  <span className="app-stack app-catalog-retry">
                    <span className="app-form-error" role="alert">
                      {failed.text}
                    </span>
                    <span className="app-copy-row">
                      <Input
                        aria-label={t('connectors.slug')}
                        value={failed.slug}
                        maxLength={32}
                        onChange={(event) => setFailed({ ...failed, slug: event.target.value })}
                      />
                      <Button loading={busy === entry.id} onClick={() => void install(entry, failed.slug.trim())}>
                        {t('connectors.install')}
                      </Button>
                    </span>
                  </span>
                )}
              </span>
              {entry.installed_slug ? (
                <span className="app-list-time">{t('connectors.installedAs', { slug: entry.installed_slug })}</span>
              ) : (
                failed?.id !== entry.id && (
                  <Button
                    size="sm"
                    aria-label={t('connectors.installNamed', { name: titleOf(entry) })}
                    loading={busy === entry.id}
                    onClick={() => void install(entry)}
                  >
                    {t('connectors.install')}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={t('connectors.noMatch')} />
      )}
    </div>
  );
}

/** Seconds since `running` became true; 0 when it is not. */
function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return running ? seconds : 0;
}

/** What a Registry server fills in the address form; a header it needs suggests each member's key. */
export function draftFromRegistry(result: RegistryResult): Partial<ConnectorDraft> {
  const remote = result.remotes[0]!;
  const header = remote.headers.find((item) => item.secret || item.required);
  const name = result.title ?? result.name.split('/').pop() ?? result.name;
  return {
    name,
    slug: slugFrom(name, remote.url),
    description: result.description,
    url: remote.url,
    transport: remote.transport,
    ...(header ? { auth_mode: 'per_member' as const, place: 'header' as const, header: header.name } : {}),
  };
}

/** What was typed and what was last searched; kept by the drawer so another tab and back keeps the results. */
type RegistrySearch = { query: string; asked: string | null };

function RegistryTab({
  search: { query, asked },
  onSearch,
  onUse,
  onCatalog,
}: {
  search: RegistrySearch;
  onSearch: (search: RegistrySearch) => void;
  onUse: (draft: Partial<ConnectorDraft>) => void;
  onCatalog: (catalogId: string) => void;
}) {
  const { t } = useI18n();
  const setQuery = (next: string) => onSearch({ query: next, asked });
  const results = useQuery({
    queryKey: connectorKeys.registry(asked ?? ''),
    queryFn: () => api.admin.connectors.registry(asked ?? ''),
    enabled: asked !== null,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const seconds = useElapsed(results.isFetching);
  const search = (event: FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    if (next === asked) void results.refetch();
    else onSearch({ query, asked: next });
  };
  let body = null;
  if (asked !== null) {
    if (results.isFetching)
      body = (
        <p className="app-muted" role="status">
          {t('connectors.searching', { seconds })}
        </p>
      );
    else if (results.isError)
      body = <ErrorBox onRetry={() => void results.refetch()}>{errorText(results.error, t)}</ErrorBox>;
    else if (!results.data?.items.length) body = <Empty title={t('connectors.registryNone')} />;
    else
      body = (
        <ul className="app-list">
          {results.data.items.map((result) => {
            const remote = result.remotes[0]!;
            const headers = remote.headers.filter((header) => header.required || header.secret);
            return (
              <li key={`${result.name}@${result.version}`} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">{result.title ?? result.name}</span>
                  {result.description && <span className="app-muted">{result.description}</span>}
                  <span className="app-list-meta">
                    {[
                      remote.url,
                      headers.length > 0 &&
                        t('connectors.needsHeaders', { headers: headers.map((header) => header.name).join(', ') }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {result.catalog_id ? (
                  <Button size="sm" onClick={() => onCatalog(result.catalog_id!)}>
                    {t('connectors.inCatalog')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => onUse(draftFromRegistry(result))}>
                    {t('connectors.useAddress')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      );
  }
  return (
    <div className="app-section">
      <form className="app-toolbar" onSubmit={search} role="search">
        <SearchInput
          value={query}
          onChange={setQuery}
          label={t('connectors.searchRegistry')}
          placeholder={t('connectors.searchRegistry')}
        />
        <Button type="submit" loading={results.isFetching}>
          {t('connectors.search')}
        </Button>
      </form>
      <p className="app-muted">{t('connectors.registryNote')}</p>
      {body}
    </div>
  );
}

function probeText(result: ProbeResult, t: Translate): string {
  switch (result.auth) {
    case 'none':
      return t('connectors.probe.none', { count: result.tool_count ?? 0 });
    case 'oauth':
      return result.dynamic_registration === false ? t('connectors.probe.oauthManual') : t('connectors.probe.oauth');
    case 'key':
      return t('connectors.probe.key');
    default:
      return t('connectors.probe.unknown', { error: result.error ?? '' });
  }
}

function UrlTab({
  prefill,
  onInstalled,
}: {
  prefill: Partial<ConnectorDraft> | null;
  onInstalled: (connector: Connector) => void;
}) {
  const { t } = useI18n();
  const installed = useInstalled(onInstalled);
  const [draft, setDraft] = useState<ConnectorDraft>(() => ({ ...blankDraft(), ...prefill }));
  const [slugTouched, setSlugTouched] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<DraftError>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<ConnectorDraft>) => {
    if (patch.slug !== undefined) setSlugTouched(true);
    setError(null);
    setDraft((current) => {
      const next = { ...current, ...patch };
      // The slug follows the name (or the address) until it is typed.
      if (!slugTouched && patch.slug === undefined && (patch.name !== undefined || patch.url !== undefined)) {
        next.slug = slugFrom(next.name, next.url);
      }
      return next;
    });
  };

  const detect = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const result = await api.admin.connectors.probe(draft.url.trim(), draft.transport);
      setProbe(result);
      if (result.auth === 'none' || result.auth === 'oauth') set({ auth_mode: result.auth });
      else if (result.auth === 'key' && (draft.auth_mode === 'none' || draft.auth_mode === 'oauth')) {
        set({ auth_mode: 'per_member' });
      }
    } catch (caught) {
      setError({ field: 'url', text: errorText(caught, t) });
    } finally {
      setProbing(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = draftProblem(draft, null);
    if (problem) return setError({ field: problem.field, text: t(problem.word) });
    setSaving(true);
    try {
      await installed(await api.admin.connectors.create(createInput(draft)));
    } catch (caught) {
      setSaving(false);
      const taken = caught instanceof ApiClientError && caught.code === 'connector_slug_taken';
      setError({ field: taken ? 'slug' : 'url', text: installProblem(caught, t) });
    }
  };

  return (
    <form id="connector-install" className="app-form" onSubmit={(event) => void submit(event)} noValidate>
      <Field
        label={t('connectors.url')}
        required
        error={error?.field === 'url' ? error.text : undefined}
        description={t('connectors.urlHint')}
      >
        <Input
          type="url"
          value={draft.url}
          placeholder="https://example.com/mcp"
          onChange={(event) => {
            set({ url: event.target.value });
            setProbe(null);
          }}
        />
      </Field>
      <div className="app-inline-actions">
        <Button loading={probing} disabled={!draft.url.trim()} onClick={() => void detect()}>
          {t('connectors.detect')}
        </Button>
        {probe && (
          <span className="app-muted app-inline-status" role="status">
            {probeText(probe, t)}
          </span>
        )}
      </div>
      <TransportField value={draft.transport} onChange={(transport) => set({ transport })} />
      <ConnectorFields draft={draft} set={set} error={error} />
      <OverlayActions>
        <Button kind="primary" type="submit" form="connector-install" loading={saving}>
          {t('connectors.install')}
        </Button>
      </OverlayActions>
    </form>
  );
}

export function AddConnectorDrawer({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (connector: Connector) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<Source>('catalog');
  const [prefill, setPrefill] = useState<{ draft: Partial<ConnectorDraft>; at: number } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistrySearch>({ query: '', asked: null });
  return (
    <Overlay title={t('connectors.add')} help={t('connectors.addHelp')} onClose={onClose}>
      <div className="app-overlay-stack">
        <Tabs
          label={t('connectors.add')}
          items={SOURCES.map((item) => t(SOURCE_LABEL[item]))}
          value={t(SOURCE_LABEL[source])}
          onChange={(label) => setSource(SOURCES.find((item) => t(SOURCE_LABEL[item]) === label) ?? 'catalog')}
        />
        {source === 'catalog' && <CatalogTab focus={focus} onInstalled={onInstalled} />}
        {source === 'registry' && (
          <RegistryTab
            search={registry}
            onSearch={setRegistry}
            onUse={(draft) => {
              setPrefill({ draft, at: Date.now() });
              setSource('url');
            }}
            onCatalog={(catalogId) => {
              setFocus(catalogId);
              setSource('catalog');
            }}
          />
        )}
        {source === 'url' && (
          <UrlTab key={prefill?.at ?? 0} prefill={prefill?.draft ?? null} onInstalled={onInstalled} />
        )}
      </div>
    </Overlay>
  );
}
