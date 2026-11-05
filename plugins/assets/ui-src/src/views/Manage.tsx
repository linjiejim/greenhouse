import { useEffect, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { go } from '../router';
import { useLibrary } from '../state';
import type { AssetCard, Facet } from '../types';
import { Thumb } from '../components/tile';
import { Button, EmptyState, Field, Spinner, TextArea, TextInput, toast, toastError } from '../components/ui';
import { Library } from './Library';

export function Manage({ tab }: { tab: 'facets' | 'duplicates' | 'bin' }) {
  const t = useT();
  const config = useLibrary((s) => s.config);
  if (config && !config.can_manage) return <EmptyState icon={<Copy size={28} />} title={t('managersOnly')} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-edge px-5">
        {(['facets', 'duplicates', 'bin'] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-selected={tab === id}
            onClick={() => go(`#/manage/${id}`)}
            className={`h-10 border-b-2 px-3 text-[13px] font-semibold ${tab === id ? 'border-accent text-fg' : 'border-transparent text-fg-secondary hover:text-fg'}`}
          >
            {id === 'facets' ? t('facetsTab') : id === 'duplicates' ? t('duplicatesTab') : t('binTab')}
          </button>
        ))}
      </div>
      {tab === 'facets' ? <FacetsEditor /> : tab === 'duplicates' ? <Duplicates /> : <Library base="#/manage/bin" bin />}
    </div>
  );
}

interface FacetDraft {
  key: string;
  label_zh: string;
  label_en: string;
  multiple: boolean;
  values: string;
}

const toDraft = (f: Facet): FacetDraft => ({
  key: f.key,
  label_zh: f.label_zh,
  label_en: f.label_en,
  multiple: f.multiple,
  values: f.values.map((v) => (v.zh ? `${v.value} | ${v.zh}` : v.value)).join('\n'),
});

const fromDraft = (d: FacetDraft): Facet => ({
  key: d.key.trim(),
  label_zh: d.label_zh.trim(),
  label_en: d.label_en.trim(),
  multiple: d.multiple,
  values: d.values
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter(([value]) => value)
    .map(([value, zh]) => (zh ? { value, zh } : { value })),
});

function FacetsEditor() {
  const t = useT();
  const { config, loadConfig } = useLibrary();
  const [drafts, setDrafts] = useState<FacetDraft[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDrafts((config?.facets ?? []).map(toDraft)), [config]);
  const set = (i: number, patch: Partial<FacetDraft>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const save = async () => {
    setBusy(true);
    try {
      await api.saveFacets(drafts.map(fromDraft));
      await loadConfig();
      toast(t('saved'));
    } catch (error) {
      toastError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <p className="mb-4 max-w-2xl text-[13px] text-fg-secondary">{t('facetsHint')}</p>
      <div className="flex max-w-3xl flex-col gap-3">
        {drafts.map((d, i) => (
          <div key={i} className="grid gap-3 rounded-2xl border border-edge bg-surface-card p-4 md:grid-cols-2">
            <Field label={t('labelZh')}>
              <TextInput value={d.label_zh} maxLength={60} onChange={(e) => set(i, { label_zh: e.target.value })} />
            </Field>
            <Field label={t('labelEn')}>
              <TextInput value={d.label_en} maxLength={60} onChange={(e) => set(i, { label_en: e.target.value })} />
            </Field>
            <Field label={t('facetKey')}>
              <TextInput
                value={d.key}
                maxLength={40}
                className="font-mono"
                onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              />
            </Field>
            <label className="flex items-center gap-2 self-end pb-1.5 text-[14px]">
              <input type="checkbox" checked={d.multiple} onChange={(e) => set(i, { multiple: e.target.checked })} />
              {t('multiple')}
            </label>
            <div className="md:col-span-2">
              <Field label={t('values')}>
                <TextArea rows={5} value={d.values} onChange={(e) => set(i, { values: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end md:col-span-2">
              <Button variant="ghost" className="text-danger" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                <Trash2 size={16} />
                {t('remove')}
              </Button>
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <Button onClick={() => setDrafts([...drafts, { key: '', label_zh: '', label_en: '', multiple: true, values: '' }])}>
            <Plus size={16} />
            {t('addFacet')}
          </Button>
          <div className="flex-1" />
          <Button
            variant="primary"
            busy={busy}
            disabled={drafts.some((d) => !/^[a-z][a-z0-9_]*$/.test(d.key) || !d.label_zh.trim() || !d.label_en.trim())}
            onClick={save}
          >
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Duplicates() {
  const t = useT();
  const [pairs, setPairs] = useState<Array<{ distance: number; a: AssetCard; b: AssetCard }> | null>(null);
  const load = () =>
    api
      .duplicates()
      .then((r) => setPairs(r.pairs))
      .catch((error: Error) => (toastError(error.message), setPairs([])));
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      void load();
    } catch (error) {
      toastError((error as Error).message);
    }
  };
  if (!pairs) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  if (!pairs.length) return <EmptyState icon={<Copy size={28} />} title={t('noDuplicates')} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="flex max-w-3xl flex-col gap-3">
        {pairs.map(({ a, b }) => (
          <div key={`${a.id}:${b.id}`} className="flex flex-col gap-3 rounded-2xl border border-edge bg-surface-card p-3">
            <div className="grid grid-cols-2 gap-3">
              {[a, b].map((asset) => (
                <a key={asset.id} href={`#/asset/${encodeURIComponent(asset.id)}`} className="flex min-w-0 flex-col gap-1">
                  <div className="aspect-[4/3] overflow-hidden rounded-xl border border-edge">
                    <Thumb asset={asset} />
                  </div>
                  <span className="truncate text-[13px]">{asset.title}</span>
                </a>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => act(() => api.dismiss(a.id, b.id))}>{t('notDuplicate')}</Button>
              <Button onClick={() => act(() => api.merge(a.id, b.id))}>{t('keepLeft')}</Button>
              <Button onClick={() => act(() => api.merge(b.id, a.id))}>{t('keepRight')}</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
