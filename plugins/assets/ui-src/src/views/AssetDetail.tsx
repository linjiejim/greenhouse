import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, Pencil, RotateCcw, Sparkles, Trash2, UserRound } from 'lucide-react';
import { api } from '../api';
import { useEmbed } from '../embed';
import { formatBytes, formatDate, formatDuration, useT } from '../i18n';
import { assetLink, facetLabel, useLibrary, valueLabel } from '../state';
import type { AssetDetail as Detail, FacetValues } from '../types';
import { FacetPicker } from '../components/facets';
import { Thumb } from '../components/tile';
import {
  Badge,
  Button,
  Chip,
  DetailList,
  Drawer,
  IconButton,
  notify,
  Skeleton,
  Spinner,
  StateView,
  TagInput,
  TextArea,
  TextInput,
  useDelayedFlag,
  useHostTitle,
} from '../components/ui';

interface Draft {
  title: string;
  description: string;
  source: string;
  tags: string[];
  facets: FacetValues;
}

const draftOf = (a: Detail): Draft => ({
  title: a.member.title ?? '',
  description: a.member.description ?? '',
  source: a.member.source ?? '',
  tags: a.member.tags,
  facets: a.member.facets,
});

/**
 * One asset in the side drawer (DESIGN.md Embeds): view it, edit its member fields in place (same
 * rows, values become controls), move it to the bin with Undo.
 */
export function AssetDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const locale = useEmbed((s) => s.locale);
  const { config, people } = useLibrary();
  const [asset, setAsset] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const showSkeleton = useDelayedFlag(!asset && !failed);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { asset } = await api.get(id);
      setAsset(asset);
      setDraft((current) => (current && editing ? current : draftOf(asset)));
    } catch {
      setFailed(true);
    }
    // keep a draft being edited when the AI poll reloads the asset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // While the AI is still working, look again every few seconds.
  useEffect(() => {
    if (!asset || (asset.ai.status !== 'pending' && asset.ai.status !== 'running')) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [asset, load]);
  useHostTitle(asset?.title);

  const name = (userId: string) => people.get(userId) ?? userId;
  const facets = config?.facets ?? [];
  const dirty = !!(editing && asset && draft && JSON.stringify(draftOf(asset)) !== JSON.stringify(draft));
  const editable = !!asset && asset.can_edit && asset.status === 'active';

  const save = async () => {
    if (!asset || !draft) return;
    setBusy(true);
    try {
      const { asset: next } = await api.update(asset.id, {
        title: draft.title || null,
        description: draft.description || null,
        source: draft.source || null,
        tags: draft.tags,
        facets: draft.facets,
      });
      setAsset(next);
      setDraft(draftOf(next));
      setEditing(false);
      onChanged();
    } catch (error) {
      notify.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const accept = async (fields: Array<'title' | 'description' | 'tags' | 'facets'>) => {
    if (!asset) return;
    try {
      const { asset: next } = await api.acceptAi(asset.id, fields);
      setAsset(next);
      setDraft(draftOf(next));
      onChanged();
    } catch (error) {
      notify.error((error as Error).message);
    }
  };

  const download = async () => {
    if (!asset) return;
    try {
      const { url } = await api.download(asset.id);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      notify.error((error as Error).message);
    }
  };

  const copy = async () => {
    if (!asset) return;
    try {
      await navigator.clipboard.writeText(assetLink(asset.id));
      notify.success(t('copied'));
    } catch {
      notify.warning(t('copyFailed', { link: assetLink(asset.id) }));
    }
  };

  // The bin keeps it 30 days: move it at once and offer Undo instead of asking first.
  const remove = async () => {
    if (!asset) return;
    try {
      await api.remove(asset.id);
      onChanged();
      onClose();
      notify.undo(t('deletedOne', { name: asset.title }), () => {
        void api.restore(asset.id).then(onChanged, (error: Error) => notify.error(error.message));
      });
    } catch (error) {
      notify.error((error as Error).message);
    }
  };

  const restore = async () => {
    if (!asset) return;
    await api.restore(asset.id).catch((error: Error) => notify.error(error.message));
    onChanged();
    void load();
  };

  const cancelEdit = () => {
    if (asset) setDraft(draftOf(asset));
    setEditing(false);
  };

  return (
    <Drawer
      size="lg"
      title={asset?.title ?? ''}
      meta={asset ? `${asset.original_name} · ${formatBytes(asset.size)}` : undefined}
      dirty={dirty}
      onClose={onClose}
      actions={
        editable && !editing ? (
          <IconButton label={t('edit')} onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </IconButton>
        ) : null
      }
      footer={
        editing ? (
          <>
            <Button onClick={cancelEdit}>{t('cancel')}</Button>
            <Button variant="primary" onClick={save} disabled={!dirty} busy={busy}>
              {t('save')}
            </Button>
          </>
        ) : undefined
      }
    >
      {failed && !asset ? (
        <StateView kind="error" onRetry={() => void load()} />
      ) : !asset || !draft ? (
        showSkeleton ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="aspect-[4/3] w-full rounded-card" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : null
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-card bg-sunken">
            {asset.kind === 'video' && asset.media_url ? (
              <video
                key={asset.media_url}
                src={asset.media_url}
                poster={asset.preview_url ?? undefined}
                controls
                playsInline
                preload="metadata"
                className="h-full w-full object-contain"
              />
            ) : asset.preview_url || asset.media_url ? (
              <img
                src={asset.media_url && asset.size < 25 * 1024 * 1024 ? asset.media_url : asset.preview_url!}
                alt={asset.title}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="h-32 w-32">
                <Thumb asset={asset} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={download}>
              <Download size={16} />
              {t('download')}
            </Button>
            <Button onClick={copy}>
              <Copy size={16} />
              {t('copyLink')}
            </Button>
            {asset.can_manage && asset.status === 'active' ? (
              <Button variant="ghost" className="text-destructive" onClick={remove}>
                <Trash2 size={16} />
                {t('delete')}
              </Button>
            ) : null}
            {asset.can_manage && asset.status === 'deleted' ? (
              <Button onClick={restore}>
                <RotateCcw size={16} />
                {t('restore')}
              </Button>
            ) : null}
          </div>

          <AiPanel
            asset={asset}
            onAccept={accept}
            onRetry={async () => {
              await api.retryAi(asset.id).catch((error: Error) => notify.error(error.message));
              void load();
            }}
            aiEnabled={config?.ai_enabled ?? false}
          />

          <section className="flex flex-col gap-2">
            <h3 className="text-title-sm font-semibold text-foreground">{t('details')}</h3>
            {!asset.can_edit ? <p className="text-caption text-muted-foreground">{t('readOnlyHint')}</p> : null}
            <DetailList
              editing={editing}
              rows={[
                {
                  label: t('title'),
                  value: asset.member.title ?? <span className="text-faint-foreground">{asset.title}</span>,
                  edit: (
                    <TextInput
                      value={draft.title}
                      maxLength={200}
                      aria-label={t('title')}
                      placeholder={asset.ai.title ?? asset.original_name}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      autoFocus
                    />
                  ),
                },
                {
                  label: t('description'),
                  value: asset.member.description ?? '—',
                  edit: (
                    <TextArea
                      value={draft.description}
                      maxLength={4000}
                      aria-label={t('description')}
                      placeholder={asset.ai.caption ?? ''}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  ),
                },
                {
                  label: t('tags'),
                  value: asset.member.tags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {asset.member.tags.map((tag) => (
                        <Chip key={tag}>{tag}</Chip>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
                  edit: <TagInput value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} placeholder={t('tagsHint')} />,
                },
                {
                  label: t('source'),
                  value: asset.member.source ?? '—',
                  edit: (
                    <TextInput
                      value={draft.source}
                      maxLength={500}
                      aria-label={t('source')}
                      placeholder={t('sourceHint')}
                      onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                    />
                  ),
                },
                ...facets.map((facet) => ({
                  label: facetLabel(facet, locale),
                  value: (asset.member.facets[facet.key] ?? []).length
                    ? (asset.member.facets[facet.key] ?? []).map((v) => valueLabel(facet, v, locale)).join('、')
                    : '—',
                  edit: (
                    <FacetPicker
                      facets={[facet]}
                      value={draft.facets}
                      suggested={asset.ai.facets}
                      hideLabels
                      onChange={(next) => setDraft({ ...draft, facets: next })}
                    />
                  ),
                })),
              ]}
            />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-title-sm font-semibold text-foreground">{t('information')}</h3>
            <DetailList
              rows={[
                { label: t('file'), value: <span className="truncate" title={asset.original_name}>{asset.original_name}</span> },
                { label: t('size'), value: formatBytes(asset.size) },
                ...(asset.width ? [{ label: t('dimensions'), value: `${asset.width} × ${asset.height}` }] : []),
                ...(asset.duration_ms ? [{ label: t('duration'), value: formatDuration(asset.duration_ms) }] : []),
                { label: t('uploadedBy'), value: name(asset.uploaded_by) },
                { label: t('uploadedAt'), value: formatDate(asset.created_at, locale) },
                ...(asset.uploaders.some((u) => u.user_id !== asset.uploaded_by)
                  ? [
                      {
                        label: t('alsoUploadedBy'),
                        value: asset.uploaders
                          .filter((u) => u.user_id !== asset.uploaded_by)
                          .map((u) => name(u.user_id))
                          .join('、'),
                      },
                    ]
                  : []),
                ...(asset.collections.length
                  ? [
                      {
                        label: t('inCollections'),
                        value: (
                          <span className="flex flex-wrap gap-2">
                            {asset.collections.map((c) => (
                              <a key={c.id} href={`#/collection/${encodeURIComponent(c.id)}`} className="text-primary-fg hover:underline">
                                {c.name}
                              </a>
                            ))}
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </section>

          {asset.similar.length ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-title-sm font-semibold text-foreground">{t('similar')}</h3>
              <div className="flex gap-2 overflow-x-auto">
                {asset.similar.map((s) => (
                  <a
                    key={s.id}
                    href={`#/asset/${encodeURIComponent(s.id)}`}
                    className="h-20 w-20 shrink-0 overflow-hidden rounded-control border border-border"
                    title={s.title}
                  >
                    <Thumb asset={s} />
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function AiPanel({
  asset,
  aiEnabled,
  onAccept,
  onRetry,
}: {
  asset: Detail;
  aiEnabled: boolean;
  onAccept: (fields: Array<'title' | 'description' | 'tags' | 'facets'>) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const locale = useEmbed((s) => s.locale);
  const facets = useLibrary((s) => s.config?.facets ?? []);
  const { ai } = asset;
  const editable = asset.can_edit && asset.status === 'active';
  if (ai.status === 'pending' || ai.status === 'running')
    return (
      <div className="flex items-center gap-2 rounded-card bg-sunken px-3 py-2.5 text-body-sm text-muted-foreground">
        <Spinner size={14} />
        {aiEnabled ? t('aiPending') : t('aiOff')}
      </div>
    );
  if (ai.status === 'failed' || ai.status === 'skipped')
    return (
      <div className="flex items-center justify-between gap-2 rounded-card bg-sunken px-3 py-2.5 text-body-sm text-muted-foreground">
        <span className="min-w-0">
          {ai.status === 'failed' ? t('aiFailed') : t('aiSkipped')}
          {ai.error ? <span className="block truncate text-caption text-faint-foreground">{ai.error}</span> : null}
        </span>
        {editable && asset.has_preview && aiEnabled ? (
          <Button compact onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    );
  const facetEntries = facets.filter((f) => ai.facets[f.key]?.length);
  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-dashed border-input px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-label font-semibold">
          <Sparkles size={14} className="text-primary-fg" />
          {t('aiSuggestions')}
        </span>
        {editable ? (
          <Button compact onClick={() => onAccept(['title', 'description', 'tags', 'facets'])}>
            {t('acceptAll')}
          </Button>
        ) : null}
      </div>
      {ai.title ? <Suggestion text={ai.title} onAccept={editable ? () => onAccept(['title']) : undefined} /> : null}
      {ai.caption ? (
        <Suggestion text={ai.caption} muted onAccept={editable ? () => onAccept(['description']) : undefined} />
      ) : null}
      {ai.tags.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {ai.tags.map((tag) => (
            <Chip key={tag} ai>
              {tag}
            </Chip>
          ))}
          {editable ? (
            <Button compact variant="ghost" onClick={() => onAccept(['tags'])}>
              {t('accept')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {facetEntries.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {facetEntries.flatMap((f) =>
            ai.facets[f.key]!.map((v) => (
              <Chip key={`${f.key}:${v}`} ai>
                {facetLabel(f, locale)}: {valueLabel(f, v, locale)}
              </Chip>
            )),
          )}
          {editable ? (
            <Button compact variant="ghost" onClick={() => onAccept(['facets'])}>
              {t('accept')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {ai.text ? (
        <div className="text-caption text-muted-foreground">
          <span className="font-semibold">{t('visibleText')}：</span>
          {ai.text}
        </div>
      ) : null}
      {ai.people ? (
        <div className="flex items-start gap-1.5 text-caption text-warning-fg">
          <UserRound size={14} className="mt-0.5 shrink-0" />
          {t('people')}
        </div>
      ) : null}
      {ai.model ? <Badge>{ai.model}</Badge> : null}
    </div>
  );
}

function Suggestion({ text, muted, onAccept }: { text: string; muted?: boolean; onAccept?: () => void }) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-2">
      <p className={`min-w-0 text-body-sm ${muted ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>{text}</p>
      {onAccept ? (
        <Button compact variant="ghost" onClick={onAccept}>
          {t('accept')}
        </Button>
      ) : null}
    </div>
  );
}
