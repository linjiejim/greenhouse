import { useEffect, useState } from 'react';
import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { go } from '../router';
import { useLibrary } from '../state';
import { useEmbed } from '../embed';
import { Button, confirm, Dialog, Field, IconButton, notify, Skeleton, StateView, TextArea, TextInput, useDelayedFlag } from '../components/ui';

export function Collections() {
  const t = useT();
  const { collections, collectionsState, people, loadCollections } = useLibrary();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    void loadCollections().catch(() => {});
  }, [loadCollections]);
  const showSkeleton = useDelayedFlag(collectionsState === 'loading');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setEditing(true)}>
          <Plus size={16} />
          {t('newCollection')}
        </Button>
      </div>
      {collectionsState === 'failed' ? (
        <StateView kind="error" onRetry={() => void loadCollections().catch(() => {})} />
      ) : collectionsState === 'loading' ? (
        showSkeleton ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-card" />
            ))}
          </div>
        ) : null
      ) : !collections.length ? (
        <StateView kind="empty" icon={<FolderOpen size={24} />} title={t('noCollections')} hint={t('noCollectionsHint')} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => go(`#/collection/${encodeURIComponent(c.id)}`)}
              className="flex flex-col gap-1 rounded-card border border-border bg-card px-4 py-3 text-left hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex items-center gap-2 text-title-sm font-semibold">
                <FolderOpen size={16} className="text-faint-foreground" />
                <span className="truncate">{c.name}</span>
              </span>
              {c.description ? <span className="line-clamp-2 text-body-sm text-muted-foreground">{c.description}</span> : null}
              <span className="text-caption text-muted-foreground">
                {t('count', { n: c.count })} · {people.get(c.created_by) ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {editing ? <CollectionForm onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

export function CollectionForm({
  existing,
  onClose,
}: {
  existing?: { id: string; name: string; description: string | null };
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (existing) await api.updateCollection(existing.id, { name: name.trim(), description: description.trim() || null });
      else {
        const { collection } = await api.createCollection(name.trim(), description.trim() || undefined);
        go(`#/collection/${encodeURIComponent(collection.id)}`);
      }
      await useLibrary.getState().loadCollections();
      onClose();
    } catch (error) {
      notify.error((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      size="sm"
      title={existing ? t('rename') : t('newCollection')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            onClick={save}
            busy={busy}
            disabled={!name.trim() || (!!existing && name === existing.name && description === (existing.description ?? ''))}
          >
            {existing ? t('save') : t('createCollection')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('collectionName')} required>
          <TextInput autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('description')}>
          <TextArea maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** The bar above a collection's assets: its name, rename and delete for its creator or a manager. */
export function CollectionHeader({ id }: { id: string }) {
  const t = useT();
  const { collections, config } = useLibrary();
  const me = useEmbed((s) => s.user);
  const collection = collections.find((c) => c.id === id);
  const [editing, setEditing] = useState(false);
  if (!collection) return null;
  const mayChange = collection.created_by === me?.id || Boolean(config?.can_manage);
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
      <FolderOpen size={16} className="text-faint-foreground" />
      <span className="min-w-0 flex-1 truncate text-title-sm font-semibold">{collection.name}</span>
      {mayChange ? (
        <>
          <IconButton label={t('rename')} onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </IconButton>
          <IconButton
            label={t('deleteCollection')}
            onClick={async () => {
              const ok = await confirm({
                title: t('deleteCollectionTitle', { name: collection.name }),
                body: t('deleteCollectionHint'),
                confirmLabel: t('deleteCollection'),
                tone: 'danger',
              });
              if (!ok) return;
              try {
                await api.deleteCollection(id);
                await useLibrary.getState().loadCollections();
                go('#/collections');
              } catch (error) {
                notify.error((error as Error).message);
              }
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        </>
      ) : null}
      {editing ? <CollectionForm existing={collection} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
