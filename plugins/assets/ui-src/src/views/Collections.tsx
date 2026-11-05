import { useEffect, useState } from 'react';
import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { go } from '../router';
import { useLibrary } from '../state';
import { useEmbed } from '../embed';
import { Button, confirmAction, Dialog, EmptyState, Field, IconButton, TextArea, TextInput, toastError } from '../components/ui';

export function Collections() {
  const t = useT();
  const { collections, people, loadCollections } = useLibrary();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setEditing(true)}>
          <Plus size={16} />
          {t('newCollection')}
        </Button>
      </div>
      {!collections.length ? (
        <EmptyState icon={<FolderOpen size={28} />} title={t('noCollections')} hint={t('noCollectionsHint')} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => go(`#/collection/${encodeURIComponent(c.id)}`)}
              className="flex flex-col gap-1 rounded-2xl border border-edge bg-surface-card px-4 py-3 text-left hover:border-accent"
            >
              <span className="flex items-center gap-2 text-[15px] font-bold">
                <FolderOpen size={16} className="text-fg-muted" />
                <span className="truncate">{c.name}</span>
              </span>
              {c.description ? <span className="line-clamp-2 text-[13px] text-fg-secondary">{c.description}</span> : null}
              <span className="text-[12px] text-fg-muted">
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
      toastError((error as Error).message);
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
          <Button variant="primary" onClick={save} busy={busy} disabled={!name.trim()}>
            {t('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('collectionName')}>
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
    <div className="flex items-center gap-2 border-b border-edge px-5 py-2.5">
      <FolderOpen size={16} className="text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{collection.name}</span>
      {mayChange ? (
        <>
          <IconButton label={t('rename')} onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </IconButton>
          <IconButton
            label={t('deleteCollection')}
            onClick={async () => {
              if (!(await confirmAction(t('deleteCollectionConfirm'), t('deleteCollection')))) return;
              try {
                await api.deleteCollection(id);
                await useLibrary.getState().loadCollections();
                go('#/collections');
              } catch (error) {
                toastError((error as Error).message);
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
