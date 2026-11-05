import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, RotateCcw, Sparkles, Trash2, UserRound } from 'lucide-react';
import { api } from '../api';
import { bridge, useEmbed } from '../embed';
import { formatBytes, formatDate, formatDuration, useT } from '../i18n';
import { assetLink, facetLabel, useLibrary, valueLabel } from '../state';
import type { AssetDetail as Detail, FacetValues } from '../types';
import { FacetPicker } from '../components/facets';
import { Thumb } from '../components/tile';
import {
  Badge,
  Button,
  Chip,
  confirmAction,
  Dialog,
  Field,
  Spinner,
  TagInput,
  TextArea,
  TextInput,
  toast,
  toastError,
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

export function AssetDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const locale = useEmbed((s) => s.locale);
  const { config, people } = useLibrary();
  const [asset, setAsset] = useState<Detail | null>(null);
  const [failed, setFailed] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { asset } = await api.get(id);
      setAsset(asset);
      setDraft(draftOf(asset));
    } catch (error) {
      setFailed((error as Error).message);
    }
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
  useEffect(() => {
    if (asset) bridge.title(asset.title);
  }, [asset]);

  const name = (userId: string) => people.get(userId) ?? userId;
  const facets = config?.facets ?? [];
  const dirty = asset && draft && JSON.stringify(draftOf(asset)) !== JSON.stringify(draft);

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
      toast(t('saved'));
      onChanged();
    } catch (error) {
      toastError((error as Error).message);
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
      toastError((error as Error).message);
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
      toastError((error as Error).message);
    }
  };

  const copy = async () => {
    if (!asset) return;
    try {
      await navigator.clipboard.writeText(assetLink(asset.id));
      toast(t('copied'));
    } catch {
      toastError(assetLink(asset.id));
    }
  };

  const remove = async () => {
    if (!asset || !(await confirmAction(t('deleteConfirm'), t('delete')))) return;
    try {
      await api.remove(asset.id);
      toast(t('deleted'));
      onChanged();
      onClose();
    } catch (error) {
      toastError((error as Error).message);
    }
  };

  const restore = async () => {
    if (!asset) return;
    await api.restore(asset.id).catch((error: Error) => toastError(error.message));
    onChanged();
    void load();
  };

  return (
    <Dialog
      size="xl"
      title={asset?.title ?? ''}
      onClose={onClose}
      footer={
        asset && draft && asset.can_edit && asset.status === 'active' ? (
          <>
            <Button onClick={() => setDraft(draftOf(asset))} disabled={!dirty}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={save} disabled={!dirty} busy={busy}>
              {t('save')}
            </Button>
          </>
        ) : undefined
      }
    >
      {!asset ? (
        <div className="flex h-full items-center justify-center text-[14px] text-fg-muted">
          {failed ? failed : <Spinner />}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-surface-muted">
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
                <Button variant="ghost" className="text-danger" onClick={remove}>
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
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-fg-muted">{t('file')}</dt>
              <dd className="truncate" title={asset.original_name}>
                {asset.original_name}
              </dd>
              <dt className="text-fg-muted">{t('size')}</dt>
              <dd>{formatBytes(asset.size)}</dd>
              {asset.width ? (
                <>
                  <dt className="text-fg-muted">{t('dimensions')}</dt>
                  <dd>
                    {asset.width} × {asset.height}
                  </dd>
                </>
              ) : null}
              {asset.duration_ms ? (
                <>
                  <dt className="text-fg-muted">{t('duration')}</dt>
                  <dd>{formatDuration(asset.duration_ms)}</dd>
                </>
              ) : null}
              <dt className="text-fg-muted">{t('uploadedBy')}</dt>
              <dd>{name(asset.uploaded_by)}</dd>
              <dt className="text-fg-muted">{t('uploadedAt')}</dt>
              <dd>{formatDate(asset.created_at, locale)}</dd>
              {asset.uploaders.filter((u) => u.user_id !== asset.uploaded_by).length ? (
                <>
                  <dt className="text-fg-muted">{t('alsoUploadedBy')}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {asset.uploaders
                      .filter((u) => u.user_id !== asset.uploaded_by)
                      .map((u) => (
                        <span key={u.user_id} title={u.original_name}>
                          {name(u.user_id)}
                        </span>
                      ))}
                  </dd>
                </>
              ) : null}
              {asset.collections.length ? (
                <>
                  <dt className="text-fg-muted">{t('inCollections')}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {asset.collections.map((c) => (
                      <a key={c.id} href={`#/collection/${encodeURIComponent(c.id)}`} className="text-primary-fg hover:underline">
                        {c.name}
                      </a>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
            {asset.similar.length ? (
              <div className="flex flex-col gap-2">
                <div className="text-[13px] font-semibold text-fg-secondary">{t('similar')}</div>
                <div className="flex gap-2 overflow-x-auto">
                  {asset.similar.map((s) => (
                    <a
                      key={s.id}
                      href={`#/asset/${encodeURIComponent(s.id)}`}
                      className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-edge"
                      title={s.title}
                    >
                      <Thumb asset={s} />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <AiPanel asset={asset} onAccept={accept} onRetry={async () => {
              await api.retryAi(asset.id).catch((error: Error) => toastError(error.message));
              void load();
            }} aiEnabled={config?.ai_enabled ?? false} />
            {draft ? (
              <fieldset disabled={!asset.can_edit || asset.status !== 'active'} className="flex flex-col gap-3">
                <legend className="mb-2 text-[13px] font-bold text-fg">{t('details')}</legend>
                {!asset.can_edit ? <p className="text-[12px] text-fg-muted">{t('readOnly')}</p> : null}
                <Field label={t('title')}>
                  <TextInput
                    value={draft.title}
                    maxLength={200}
                    placeholder={asset.ai.title ?? asset.original_name}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </Field>
                <Field label={t('description')}>
                  <TextArea
                    value={draft.description}
                    maxLength={4000}
                    placeholder={asset.ai.caption ?? ''}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </Field>
                <Field label={t('tags')} hint={t('tagsHint')}>
                  <TagInput value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />
                </Field>
                <Field label={t('source')} hint={t('sourceHint')}>
                  <TextInput
                    value={draft.source}
                    maxLength={500}
                    onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                  />
                </Field>
                {facets.length ? (
                  <FacetPicker
                    facets={facets}
                    value={draft.facets}
                    suggested={asset.ai.facets}
                    onChange={(next) => setDraft({ ...draft, facets: next })}
                  />
                ) : null}
              </fieldset>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
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
      <div className="flex items-center gap-2 rounded-xl bg-surface-muted px-3 py-2.5 text-[13px] text-fg-secondary">
        <Spinner size={14} />
        {aiEnabled ? t('aiPending') : t('aiOff')}
      </div>
    );
  if (ai.status === 'failed' || ai.status === 'skipped')
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-muted px-3 py-2.5 text-[13px] text-fg-secondary">
        <span className="min-w-0">
          {ai.status === 'failed' ? t('aiFailed') : t('aiSkipped')}
          {ai.error ? <span className="block truncate text-[12px] text-fg-muted">{ai.error}</span> : null}
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
    <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-edge-strong px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-bold">
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
        <div className="text-[12px] text-fg-muted">
          <span className="font-semibold">{t('visibleText')}：</span>
          {ai.text}
        </div>
      ) : null}
      {ai.people ? (
        <div className="flex items-start gap-1.5 text-[12px] text-warning-fg">
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
      <p className={`min-w-0 text-[13px] leading-[20px] ${muted ? 'text-fg-secondary' : 'font-semibold text-fg'}`}>{text}</p>
      {onAccept ? (
        <Button compact variant="ghost" onClick={onAccept}>
          {t('accept')}
        </Button>
      ) : null}
    </div>
  );
}
