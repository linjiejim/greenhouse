import React, { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import Phone from './phone-screen';
import { listDocs, listKbFolders, getDoc, type KbShelf } from '../api/knowledge';
import { get, put, api, toResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useResource } from '../data/use-resource';
import { useLibraryActions } from '../library/use-library-actions';
import { useLibraryChanges } from '../library/changes';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { Place, PlaceRow, PlaceSidebar, PlaceEmpty } from '../ui/place.web';
import { Segmented } from '../ui/segmented';
import { useT } from '../lib/i18n';
import { Markdown } from '../markdown';
import { rememberDoc, recentDocs } from '../store/knowledge';
import type { RecentDoc } from '../data/recent-docs';
import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import { alertError, promptText } from '../ui/dialogs';
import DocumentEditor from './editor/document-editor';
export default function KnowledgePlace() {
  const { width } = useWindowDimensions();
  return width < 760 ? <Phone /> : <KnowledgeDesktop />;
}
function KnowledgeDesktop() {
  const t = useT(),
    router = useRouter();
  const params = useLocalSearchParams<{ doc?: string; shelf?: string }>();
  const [query, setQuery] = useState('');
  const shelf: KbShelf | 'shared' =
    params.shelf === 'personal' ? 'personal' : params.shelf === 'shared' ? 'shared' : 'team';
  const load = useCallback(async () => {
    const current = captureIdentity();
    const [docs, folders] = await Promise.all([
      listDocs(shelf, current),
      shelf === 'shared'
        ? Promise.resolve({ ok: true as const, data: { folders: [] as DriveFolder[] } })
        : listKbFolders(shelf),
    ]);
    if (!docs.ok) return docs;
    if (!folders.ok) return folders;
    return { ok: true as const, data: { docs: docs.data.docs, folders: folders.data.folders } };
  }, [shelf]);
  const data = useResource(load);
  const actions = useLibraryActions();
  const version = useLibraryChanges((s) => s.version);
  const { refresh } = data;
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  useEffect(() => {
    void recentDocs().then(setRecent);
  }, [params.doc]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const docId = params.doc ?? data.data?.docs[0]?.id;
  const doc = useResource<{ doc: KbDoc | null }>(
    useCallback(() => (docId ? getDoc(docId) : Promise.resolve({ ok: true as const, data: { doc: null } })), [docId]),
  );
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ markdown: '', json: '{}' });
  const selected = doc.data?.doc;
  useEffect(() => {
    setEditing(false);
    if (selected) {
      setDraft({ markdown: selected.content_markdown, json: selected.content_json || '{}' });
      void rememberDoc(selected);
    }
  }, [selected]);
  const open = (id: string) => router.setParams({ doc: id });
  const row = (item: KbDoc) => (
    <PlaceRow
      key={item.id}
      title={item.title}
      selected={item.id === docId}
      onOpen={() => open(item.id)}
      items={
        shelf === 'shared'
          ? []
          : [
              { id: 'rename', title: t('library.rename'), icon: 'pen' },
              { id: 'move', title: t('library.move'), icon: 'folder' },
              { id: 'delete', title: t('library.delete'), icon: 'trash', destructive: true },
            ]
      }
      onSelect={(id) => {
        const movable = {
          kind: 'doc' as const,
          id: item.id,
          name: item.title,
          shelf: shelf === 'personal' ? ('personal' as const) : ('team' as const),
        };
        if (id === 'rename') void actions.rename(movable);
        if (id === 'move') actions.move(movable);
        if (id === 'delete') void actions.remove(movable);
      }}
    />
  );
  const tree = (parent: string | null, seen: string[] = []): React.ReactNode => {
    if (seen.length > 30) return null;
    return (
      <>
        {data.data?.folders
          .filter((f) => f.parent_id === parent && !seen.includes(f.id))
          .map((f) => (
            <div key={f.id}>
              <PlaceRow
                title={f.name}
                icon="folder"
                onOpen={() => setExpanded((v) => ({ ...v, [f.id]: !(v[f.id] ?? true) }))}
              />
              {expanded[f.id] !== false ? <div style={{ paddingLeft: 16 }}>{tree(f.id, [...seen, f.id])}</div> : null}
            </div>
          ))}
        {data.data?.docs
          .filter((d) => d.folder_id === parent && (!query || d.title.toLowerCase().includes(query.toLowerCase())))
          .map(row)}
      </>
    );
  };
  const save = async () => {
    if (!selected || saving) return;
    const current = captureIdentity();
    setSaving(true);
    const r = await put(`/api/knowledge/docs/${encodeURIComponent(selected.id)}`, {
      content_markdown: draft.markdown,
      content_json: draft.json,
    });
    if (!current()) return;
    setSaving(false);
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    setEditing(false);
    void doc.refresh();
  };
  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.knowledge')}
          query={query}
          onQuery={setQuery}
          action={
            <button
              aria-label={t('library.new')}
              onClick={() => actions.newDoc(shelf === 'personal' ? 'personal' : 'team', null)}
            >
              +
            </button>
          }
        >
          <Segmented
            value={shelf}
            onChange={(value) => router.setParams({ shelf: value, doc: undefined })}
            options={(['team', 'personal', 'shared'] as const).map((value) => ({
              value,
              label: t(`knowledge.shelf.${value}`),
            }))}
          />
          <div data-place-list>
            <h3>{t('knowledge.shelf.recent')}</h3>
            {recent.slice(0, 3).map((d) => (
              <PlaceRow key={d.id} title={d.title} onOpen={() => open(d.id)} />
            ))}
            <h3>{t('places.directory')}</h3>
            {query
              ? data.data?.docs.filter((d) => d.title.toLowerCase().includes(query.toLowerCase())).map(row)
              : tree(null)}
            {!data.data?.docs.length ? (
              <PlaceEmpty loading={data.loading} error={data.error?.message} retry={() => void refresh()} />
            ) : null}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      <Place
        title={selected?.title ?? t('nav.knowledge')}
        actions={
          selected && selected.access !== 'reader' && shelf !== 'shared' ? (
            editing ? (
              <>
                <button onClick={() => setEditing(false)}>{t('common.cancel')}</button>
                <button className="gh-primary" disabled={saving} onClick={() => void save()}>
                  {t('common.save')}
                </button>
              </>
            ) : (
              <button className="gh-primary" onClick={() => setEditing(true)}>
                {t('places.edit')}
              </button>
            )
          ) : null
        }
      >
        <div className="gh-place-scroll">
          <article className="gh-doc" data-testid="knowledge-document">
            {!selected ? (
              <PlaceEmpty
                loading={doc.loading || data.loading}
                error={doc.error?.message}
                retry={() => void doc.refresh()}
              />
            ) : (
              <>
                <div className="gh-doc-meta">
                  {t(`knowledge.shelf.${shelf}`)} · {new Date(selected.updated_at).toLocaleDateString()}
                </div>
                <h1>{selected.title}</h1>
                {editing ? (
                  <DocumentEditor
                    markdown={draft.markdown}
                    json={draft.json}
                    onChange={(markdown, json) => setDraft({ markdown, json })}
                    labels={[
                      'editor',
                      'bold',
                      'italic',
                      'bullets',
                      'numbered list',
                      'quote',
                      'code',
                      t('nav.tables'),
                      t('composer.photos'),
                      'undo',
                      'redo',
                    ]}
                    onLink={(previous) => promptText({ title: 'URL', defaultValue: previous || 'https://' })}
                    onSearchDocs={async (query) => {
                      const current = captureIdentity();
                      const r = await get<{ docs: KbDoc[] }>('/api/knowledge/docs', {
                        search: query,
                        status: 'published',
                        limit: 8,
                      });
                      return current() && r.ok ? r.data.docs : [];
                    }}
                    onUsers={async () => {
                      const current = captureIdentity();
                      const r = await get<{ users: { id: string; nickname: string; email?: string }[] }>(
                        '/api/sessions/shareable-users',
                      );
                      return current() && r.ok ? r.data.users : [];
                    }}
                    onImage={async (file) => {
                      const current = captureIdentity();
                      const form = new FormData();
                      form.append('file', file);
                      try {
                        const r = await toResult<{ url: string }>(
                          await api('/api/upload', { method: 'POST', body: form }),
                        );
                        if (!current()) return null;
                        if (!r.ok) {
                          alertError(t('library.failed'), r.message);
                          return null;
                        }
                        return r.data.url;
                      } catch {
                        alertError(t('library.failed'));
                        return null;
                      }
                    }}
                  />
                ) : (
                  <>
                    {selected.summary ? <div className="gh-doc-summary">✧ {selected.summary}</div> : null}
                    <Markdown source={selected.content_markdown} />
                  </>
                )}
              </>
            )}
          </article>
        </div>
      </Place>
    </>
  );
}
