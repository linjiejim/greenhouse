import { useId, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@greenhouse/ui/kit';
import type { AppSummary, AppTemplate } from '@greenhouse/contract';
import { useSession } from '../../app/session';
import { useApps, useAppTemplates, refreshApps } from '../../data/apps';
import { useBases } from '../../data/tables';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { Page, PageHeader } from '../../shell/Page';
import { CodeReviews } from './CodeReviews';
import { appsError } from './errors';
import '../../styles/apps.css';

function NewApp({ onClose }: { onClose: () => void }) {
  const t = useT();
  const bases = useBases();
  const formId = useId();
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = bases.items.filter((b) => b.access === 'owner' || b.access === 'builder');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const draft = await api.apps.create({ name, base_id: base });
      await refreshApps();
      onClose();
      navigate({ page: 'app-edit', id: draft.app.id });
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay variant="dialog" title={t('apps.new')} onClose={onClose}>
      <form
        id={formId}
        className="app-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label={t('apps.name')}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FieldGroup label={t('apps.base')}>
          <Select
            label={t('apps.base')}
            value={base}
            options={choices.map((b) => ({ value: b.id, label: b.name }))}
            onChange={setBase}
          />
        </FieldGroup>
        <p className="app-muted">{t('apps.baseRights')}</p>
        {error && <p role="alert">{error}</p>}
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form={formId} loading={busy} disabled={!name.trim() || !base}>
          {t('apps.new')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
function AppTile({ app }: { app: AppSummary }) {
  const t = useT();
  const { me } = useSession();
  const [error, setError] = useState('');
  const flag = async (kind: 'pin' | 'feature', value: boolean) => {
    try {
      await api.apps[kind](app.id, value);
      await refreshApps();
    } catch (e) {
      setError(appsError(e, t));
    }
  };
  return (
    <article className="app-ap-tile">
      <div className="app-ap-title">
        <LayoutGrid size={20} aria-hidden />
        <h2>{app.name}</h2>
        <Menu
          items={[
            { label: t(app.pinned ? 'apps.unpin' : 'apps.pin'), onClick: () => void flag('pin', !app.pinned) },
            ...(me?.role === 'admin'
              ? [
                  {
                    label: t(app.featured ? 'apps.unfeature' : 'apps.feature'),
                    onClick: () => void flag('feature', !app.featured),
                  },
                ]
              : []),
          ]}
        />
      </div>
      <StatusBadge status={t(app.status === 'draft' ? 'apps.draft' : 'apps.publishedStatus')} tone="neutral" />
      {app.description && <p>{app.description}</p>}
      <div className="app-ap-actions">
        {app.status === 'published' && (
          <Button onClick={() => navigate({ page: 'app', id: app.id })}>{t('apps.open')}</Button>
        )}
        {app.editable && <Button onClick={() => navigate({ page: 'app-edit', id: app.id })}>{t('apps.build')}</Button>}
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
function TemplateTile({ template }: { template: AppTemplate }) {
  const t = useT();
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inspect, setInspect] = useState(false);
  const detail = useQuery({
    queryKey: ['apps', 'template', template.id],
    queryFn: () => api.apps.templates.get(template.id),
    enabled: inspect,
  });
  const install = async () => {
    setBusy(true);
    try {
      const result = await api.apps.templates.install(template.id);
      await refreshApps();
      navigate(result.app ? { page: 'app-edit', id: result.app.app.id } : { page: 'base', id: result.base.id });
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const review = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await api.apps.templates.review(template.id, decision);
      await refreshApps();
      setInspect(false);
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="app-ap-tile">
      <h2>{template.source === 'builtin' ? t('tables.project') : template.name}</h2>
      <StatusBadge status={t(`apps.review.${template.review_status}`)} tone="neutral" />
      <p>{template.source === 'builtin' ? t('tables.projectHint') : template.description}</p>
      <div className="app-ap-actions">
        <Button loading={busy} disabled={template.review_status !== 'approved'} onClick={() => void install()}>
          {t('apps.install')}
        </Button>
        <Button onClick={() => setInspect(true)}>{t('apps.reviewContent')}</Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {inspect && (
        <Overlay variant="drawer" title={t('apps.templateStructure')} onClose={() => setInspect(false)}>
          {detail.isPending ? (
            <Skeleton lines={4} />
          ) : detail.error ? (
            <ErrorBox>{appsError(detail.error, t)}</ErrorBox>
          ) : (
            <pre className="app-ap-json">{JSON.stringify(detail.data?.content, null, 2)}</pre>
          )}
          {me?.role === 'admin' && template.source !== 'builtin' && (
            <OverlayActions>
              <Button loading={busy} onClick={() => void review('rejected')}>
                {t('apps.reject')}
              </Button>
              <Button kind="primary" loading={busy} onClick={() => void review('approved')}>
                {t('apps.approve')}
              </Button>
            </OverlayActions>
          )}
        </Overlay>
      )}
    </article>
  );
}
export function AppsHome({ newApp }: { newApp?: boolean }) {
  const t = useT();
  const { me } = useSession();
  const [reviews, setReviews] = useState(false);
  const apps = useApps();
  const templates = useAppTemplates();
  const [scope, setScope] = useState('apps.all');
  const [query, setQuery] = useState('');
  const tabs = ['apps.all', 'apps.mine', 'apps.pinned', 'apps.featured', 'apps.templates'] as const;
  const items = apps.items.filter(
    (a) =>
      a.name.toLowerCase().includes(query.toLowerCase()) &&
      (scope === 'apps.mine'
        ? a.editable
        : scope === 'apps.pinned'
          ? a.pinned
          : scope === 'apps.featured'
            ? a.featured
            : a.status === 'published'),
  );
  return (
    <Page
      header={
        <PageHeader
          title={t('nav.apps')}
          menu={me?.role === 'admin' ? [{ label: t('apps.codeReviews'), onClick: () => setReviews(true) }] : []}
          primary={
            <Button kind="primary" onClick={() => navigate({ page: 'apps', newApp: true })}>
              {t('apps.new')}
            </Button>
          }
        />
      }
    >
      <Tabs
        items={tabs.map((k) => t(k))}
        value={t(scope as (typeof tabs)[number])}
        onChange={(label) => setScope(tabs.find((k) => t(k) === label)!)}
      />
      <SearchInput label={t('search.placeholder')} value={query} onChange={setQuery} />
      {scope === 'apps.templates' ? (
        <>
          <div className="app-ap-grid">
            {templates.data?.pages
              .flatMap((p) => p.items)
              .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
              .map((a) => (
                <TemplateTile key={a.id} template={a} />
              ))}
          </div>
          {templates.hasNextPage && (
            <Button onClick={() => void templates.fetchNextPage()}>{t('knowledge.showMore')}</Button>
          )}
          {templates.error && (
            <ErrorBox onRetry={() => void templates.refetch()}>{appsError(templates.error, t)}</ErrorBox>
          )}
        </>
      ) : apps.isPending ? (
        <Skeleton lines={5} />
      ) : apps.error ? (
        <ErrorBox onRetry={() => void apps.refetch()}>{appsError(apps.error, t)}</ErrorBox>
      ) : (
        <>
          <div className="app-ap-grid">
            {items.map((app) => (
              <AppTile key={app.id} app={app} />
            ))}
          </div>
          {!items.length && <Empty title={t('apps.empty')} description={t('apps.emptyHint')} />}
          {apps.hasNextPage && <Button onClick={() => void apps.fetchNextPage()}>{t('knowledge.showMore')}</Button>}
        </>
      )}
      {reviews && <CodeReviews onClose={() => setReviews(false)} />}
      {newApp && <NewApp onClose={() => navigate({ page: 'apps' })} />}
    </Page>
  );
}
