import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import {
  Banner,
  Button,
  ConfirmDialog,
  ErrorBox,
  Field,
  FieldGroup,
  IconButton,
  Input,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  TextArea,
} from '@greenhouse/ui/kit';
import type { AppCard, AppDraft } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { appsKeys, refreshApps, useAppDraft } from '../../data/apps';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { holdNavigation, leaveTo, navigate, type Attempt } from '../../lib/router';
import { Page, PageHeader } from '../../shell/Page';
import { RolesEditor, AudienceEditor } from './AccessEditor';
import { AppCardEditor, CARD_CHOICES, newCard } from './CardEditor';
import { AppRuntime } from './AppRuntime';
import { appsError } from './errors';
import { localId, move, pageDiff } from './model';
import '../../styles/apps.css';

export function AppBuilder({ id }: { id: string }) {
  const t = useT();
  const query = useAppDraft(id);
  if (!query.data)
    return (
      <Page header={<PageHeader title={t('apps.build')} />}>
        {query.isPending ? (
          <Skeleton lines={6} />
        ) : (
          <ErrorBox onRetry={() => void query.refetch()}>{appsError(query.error, t)}</ErrorBox>
        )}
      </Page>
    );
  return <Builder key={id} initial={query.data} />;
}
function Builder({ initial }: { initial: AppDraft }) {
  const t = useT();
  const notify = useNotify();
  const id = initial.app.id;
  const base = useQuery({
    queryKey: ['apps', id, 'builder-base'],
    queryFn: () => api.tables.bases.get(initial.app.base_id),
  });
  const versions = useInfiniteQuery({
    queryKey: ['apps', id, 'versions'],
    queryFn: ({ pageParam }) => api.apps.versions(id, { cursor: pageParam, limit: 200 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });
  const [saved, setSaved] = useState(initial);
  const [publishedAudience, setPublishedAudience] = useState(initial.audience);
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState('apps.pages');
  const [active, setActive] = useState(initial.spec.pages[0]!.id);
  const [editing, setEditing] = useState<AppCard | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AppCard['kind']>('records');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [publish, setPublish] = useState(false);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState(false);
  const [template, setTemplate] = useState(false);
  const [templateName, setTemplateName] = useState(initial.app.name);
  const [preview, setPreview] = useState('');
  const [leaving, setLeaving] = useState<Attempt | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => (dirty ? holdNavigation(setLeaving) : undefined), [dirty]);
  const page = draft.spec.pages.find((p) => p.id === active) ?? draft.spec.pages[0]!;
  const changeSpec = (spec: AppDraft['spec']) => setDraft({ ...draft, spec });
  const changePage = (patch: Partial<typeof page>) =>
    changeSpec({ ...draft.spec, pages: draft.spec.pages.map((p) => (p.id === page.id ? { ...p, ...patch } : p)) });
  const accept = (result: AppDraft) => {
    setDraft(result);
    setSaved(result);
    queryClient.setQueryData(appsKeys.draft(id), result);
    void refreshApps();
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.apps.save(id, {
        revision: saved.revision,
        name: draft.app.name,
        description: draft.app.description,
        spec: draft.spec,
      });
      accept({ ...result, audience: draft.audience });
      notify(t('apps.saved'));
      return result;
    } catch (e) {
      setError(appsError(e, t));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const openPublish = async () => {
    if (dirty && !(await save())) return;
    setPublish(true);
  };
  const doPublish = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.apps.publish(id, { revision: saved.revision, notes, audience: draft.audience });
      accept(result);
      setPublishedAudience(result.audience);
      setPublish(false);
      void versions.refetch();
      notify(t('apps.published'));
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (version: number) => {
    setBusy(true);
    setError('');
    try {
      accept(await api.apps.restore(id, saved.revision, version));
      notify(t('apps.restored'));
      setHistory(false);
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const saveTemplate = async () => {
    setBusy(true);
    setError('');
    try {
      await api.apps.templates.save(id, { name: templateName });
      await refreshApps();
      setTemplate(false);
      notify(t('apps.templateSaved'));
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const latest = versions.data?.pages.flatMap((p) => p.items).find((v) => v.version === saved.app.published_version);
  const diff = pageDiff(latest?.spec, draft.spec);
  const tabs = ['apps.pages', 'apps.roles', 'apps.audience'] as const;
  return (
    <Page
      width="canvas"
      header={
        <PageHeader
          title={draft.app.name}
          badge={<StatusBadge status={t('apps.draft')} tone="neutral" />}
          primary={
            <Button kind="primary" loading={busy} onClick={() => void openPublish()}>
              {t('apps.publish')}
            </Button>
          }
          menu={[
            { label: t('apps.versions'), onClick: () => setHistory(true) },
            {
              label: t('apps.open'),
              disabled: !saved.app.published_version,
              onClick: () => navigate({ page: 'app', id }),
            },
            { label: t('apps.saveTemplate'), disabled: !saved.app.published_version, onClick: () => setTemplate(true) },
          ]}
        />
      }
    >
      <div className="app-ap-builder-head">
        <Field label={t('apps.name')}>
          <Input
            value={draft.app.name}
            maxLength={100}
            onChange={(e) => setDraft({ ...draft, app: { ...draft.app, name: e.target.value } })}
          />
        </Field>
        <Button loading={busy} disabled={!dirty} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {error && <ErrorBox onRetry={() => void api.apps.draft(id).then(accept)}>{error}</ErrorBox>}
      </div>
      <Tabs
        items={tabs.map((k) => t(k))}
        value={t(tab as (typeof tabs)[number])}
        onChange={(label) => setTab(tabs.find((k) => t(k) === label)!)}
      />
      {!base.data ? (
        base.error ? (
          <ErrorBox onRetry={() => void base.refetch()}>{appsError(base.error, t)}</ErrorBox>
        ) : (
          <Skeleton lines={4} />
        )
      ) : tab === 'apps.roles' ? (
        <>
          <RolesEditor
            base={base.data}
            roles={draft.spec.roles}
            onChange={(roles) => changeSpec({ ...draft.spec, roles })}
          />
          <FieldGroup label={t('apps.preview')}>
            <Select
              label={t('apps.preview')}
              value=""
              options={draft.spec.roles.map((r) => ({ value: r.id, label: r.name }))}
              onChange={async (role) => {
                if (dirty && !(await save())) return;
                setPreview(role);
              }}
            />
          </FieldGroup>
        </>
      ) : tab === 'apps.audience' ? (
        <AudienceEditor
          roles={draft.spec.roles}
          value={draft.audience}
          onChange={(audience) => setDraft({ ...draft, audience })}
        />
      ) : (
        <div className="app-ap-builder">
          <aside className="app-ap-pages" aria-label={t('apps.pages')}>
            {draft.spec.pages.map((p) => (
              <Button key={p.id} kind={p.id === page.id ? 'primary' : 'secondary'} onClick={() => setActive(p.id)}>
                {p.name}
              </Button>
            ))}
            <Button
              onClick={() => {
                const id = localId();
                changeSpec({
                  ...draft.spec,
                  pages: [...draft.spec.pages, { id, name: t('apps.pageName'), cards: [] }],
                });
                setActive(id);
              }}
            >
              {t('apps.addPage')}
            </Button>
          </aside>
          <section className="app-ap-canvas">
            <div className="app-ap-page-tools">
              <Field label={t('apps.pageName')}>
                <Input value={page.name} maxLength={100} onChange={(e) => changePage({ name: e.target.value })} />
              </Field>
              <Button disabled={!base.data.tables.length} onClick={() => setAdding(true)}>
                {t('apps.addCard')}
              </Button>
              <IconButton
                label={t('apps.removePage')}
                disabled={draft.spec.pages.length === 1}
                onClick={() => {
                  changeSpec({ ...draft.spec, pages: draft.spec.pages.filter((p) => p.id !== page.id) });
                  setActive(draft.spec.pages.find((p) => p.id !== page.id)!.id);
                }}
              >
                <Trash2 size={18} />
              </IconButton>
            </div>
            {!page.cards.length && <p className="app-muted">{t('apps.noCards')}</p>}
            <div className="app-ap-grid">
              {page.cards.map((card, index) => (
                <article key={card.id} className="app-ap-tile">
                  <div className="app-ap-title">
                    <h2>{card.title}</h2>
                    <IconButton label={t('apps.editCard')} onClick={() => setEditing(card)}>
                      <Pencil size={18} />
                    </IconButton>
                  </div>
                  <p className="app-muted">{t(`apps.kind.${card.kind}`)}</p>
                  {'fields' in card && (
                    <p>
                      {card.fields
                        .flatMap(
                          (id) => base.data?.tables.flatMap((t) => t.fields).find((f) => f.id === id)?.name ?? [],
                        )
                        .join(' · ')}
                    </p>
                  )}
                  <div className="app-ap-actions">
                    <IconButton
                      label={t('apps.moveUp')}
                      disabled={index === 0}
                      onClick={() => changePage({ cards: move(page.cards, index, -1) })}
                    >
                      <ArrowUp size={18} />
                    </IconButton>
                    <IconButton
                      label={t('apps.moveDown')}
                      disabled={index === page.cards.length - 1}
                      onClick={() => changePage({ cards: move(page.cards, index, 1) })}
                    >
                      <ArrowDown size={18} />
                    </IconButton>
                    <IconButton
                      label={t('apps.removeCard')}
                      onClick={() => changePage({ cards: page.cards.filter((c) => c.id !== card.id) })}
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </div>
                </article>
              ))}
            </div>
            <Field label={t('apps.description')}>
              <TextArea
                value={draft.app.description}
                maxLength={2000}
                onChange={(e) => setDraft({ ...draft, app: { ...draft.app, description: e.target.value } })}
              />
            </Field>
          </section>
        </div>
      )}
      {adding && base.data && (
        <Overlay variant="dialog" title={t('apps.addCard')} onClose={() => setAdding(false)}>
          <FieldGroup label={t('apps.cardKind')}>
            <Select
              label={t('apps.cardKind')}
              value={kind}
              options={CARD_CHOICES.map((kind) => ({ value: kind, label: t(`apps.kind.${kind}`) }))}
              onChange={(value) => setKind(value as AppCard['kind'])}
            />
          </FieldGroup>
          <OverlayActions>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button
              kind="primary"
              onClick={() => {
                setEditing(newCard(kind, base.data!, t(`apps.kind.${kind}`)));
                setAdding(false);
              }}
            >
              {t('apps.addCard')}
            </Button>
          </OverlayActions>
        </Overlay>
      )}
      {editing && base.data && (
        <AppCardEditor
          base={base.data}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(card) => {
            changePage({
              cards: page.cards.some((c) => c.id === card.id)
                ? page.cards.map((c) => (c.id === card.id ? card : c))
                : [...page.cards, card],
            });
            setEditing(null);
          }}
        />
      )}
      {publish && (
        <Overlay variant="dialog" title={t('apps.publishTitle')} onClose={() => setPublish(false)}>
          <div className="app-form">
            <p>{t('apps.publishHint')}</p>
            <p>
              {t('apps.changes', {
                pages: draft.spec.pages.length,
                cards: draft.spec.pages.flatMap((p) => p.cards).length,
                roles: draft.spec.roles.length,
                audience: draft.audience.length,
              })}
            </p>
            <p>{t('apps.diffCount', { added: diff.added, removed: diff.removed, changed: diff.changed })}</p>
            {(diff.permissions || JSON.stringify(publishedAudience) !== JSON.stringify(draft.audience)) && (
              <Banner>{t('apps.audienceChanged')}</Banner>
            )}
            <AudienceEditor
              roles={draft.spec.roles}
              value={draft.audience}
              onChange={(audience) => setDraft({ ...draft, audience })}
            />
            <Field label={t('apps.notes')}>
              <TextArea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {error && <p role="alert">{error}</p>}
          </div>
          <OverlayActions>
            <Button onClick={() => setPublish(false)}>{t('common.cancel')}</Button>
            <Button kind="primary" loading={busy} onClick={() => void doPublish()}>
              {t('apps.publish')}
            </Button>
          </OverlayActions>
        </Overlay>
      )}
      {history && (
        <Overlay variant="drawer" title={t('apps.versions')} onClose={() => setHistory(false)}>
          <p>{t('apps.versionUnchanged')}</p>
          {versions.data?.pages
            .flatMap((p) => p.items)
            .map((version) => (
              <article className="app-ap-tile" key={version.id}>
                <h2>{t('apps.version', { version: version.version })}</h2>
                <p>{version.notes}</p>
                <Button loading={busy} disabled={dirty} onClick={() => void restore(version.version)}>
                  {t('apps.restore')}
                </Button>
              </article>
            ))}
          {!versions.data?.pages[0]?.items.length && <p>{t('apps.noVersions')}</p>}
          {versions.hasNextPage && (
            <Button onClick={() => void versions.fetchNextPage()}>{t('knowledge.showMore')}</Button>
          )}
        </Overlay>
      )}
      {template && (
        <Overlay variant="dialog" title={t('apps.saveTemplate')} onClose={() => setTemplate(false)}>
          <p>{t('apps.templateHint')}</p>
          <Field label={t('apps.templateName')}>
            <Input value={templateName} maxLength={100} onChange={(e) => setTemplateName(e.target.value)} />
          </Field>
          {error && <p role="alert">{error}</p>}
          <OverlayActions>
            <Button onClick={() => setTemplate(false)}>{t('common.cancel')}</Button>
            <Button kind="primary" loading={busy} disabled={!templateName.trim()} onClick={() => void saveTemplate()}>
              {t('apps.saveTemplate')}
            </Button>
          </OverlayActions>
        </Overlay>
      )}
      {preview && (
        <Overlay variant="drawer" wide title={t('apps.preview')} onClose={() => setPreview('')}>
          <AppRuntime id={id} previewRole={preview} />
        </Overlay>
      )}
      {leaving && (
        <ConfirmDialog
          title={t('apps.leaveTitle')}
          children={t('apps.leaveHint')}
          confirmLabel={t('apps.leave')}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            dirtyRef.current = false;
            leaveTo(leaving);
            setLeaving(null);
          }}
        />
      )}
    </Page>
  );
}
