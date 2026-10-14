/**
 * A doc (`#/knowledge/:docId`, KNOW-03 to KNOW-09, KNOW-15): read at reading width with its
 * contents, links to it and comments; edited in place (`?edit=1`) with the editor. A save names
 * the version the edit started from: when someone saved in between, the page says who and when
 * and offers to reload or to save anyway (their version stays in the history) — never a silent
 * overwrite. Unsaved work holds navigation and closing the tab. Who else has it open shows in the
 * header, and live saves, presence and comments arrive through realtime events.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileQuestion, History, Pencil } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Input,
  Skeleton,
  StatusBadge,
  Tooltip,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { CHANGE_NOTE_MAX, DOC_TITLE_MAX, type DocPresence, type KnowledgeDoc } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMe } from '../../app/session';
import { useNotify } from '../../app/notify';
import { refreshTree, useBacklinks, useDoc, usePresence } from '../../data/knowledge';
import { usePeople } from '../../data/people';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useMedia } from '../../lib/media';
import { holdNavigation, href, navigate } from '../../lib/router';
import { fullTime, relativeTime } from '../../lib/time';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { useItemMenu } from './actions';
import { Comments } from './Comments';
import { DocContent, DocToc, goToHeading, useHeadings } from './DocContent';
import { DocEditor, type DocEditorHandle } from './DocEditor';
import { canArchive, canEdit, docItem, routeOf, scopeOf, staleDetails } from './helpers';
import { Crumbs, ItemIcon } from './parts';
import { revealFolders, setKnowledgeScope } from './scope';
import { VersionsDrawer } from './VersionsDrawer';

const WIDE = '(min-width: 1280px)';

/** Who else has the doc open: faces, with who is editing in the tooltip. */
function Presence({ items }: { items: readonly DocPresence[] }) {
  const { t } = useI18n();
  const { memberById } = usePeople();
  if (!items.length) return null;
  const words = (entry: DocPresence) =>
    entry.state === 'editing'
      ? t('knowledge.isEditing', { name: entry.name })
      : t('knowledge.isViewing', { name: entry.name });
  return (
    <div className="app-presence" role="group" aria-label={items.map(words).join('，')}>
      {items.slice(0, 4).map((entry) => (
        <Tooltip key={entry.member_id} label={words(entry)}>
          <span
            className={entry.state === 'editing' ? 'app-presence-face is-editing' : 'app-presence-face'}
            aria-hidden
          >
            <MemberAvatar name={entry.name} url={memberById.get(entry.member_id)?.avatar_url} size={24} />
          </span>
        </Tooltip>
      ))}
      {items.length > 4 && <span className="app-count">+{items.length - 4}</span>}
    </div>
  );
}

/** "Lin 14:20 更新", or the Agent that wrote it for them. */
function useUpdatedLine(doc: KnowledgeDoc) {
  const { t, locale } = useI18n();
  const me = useMe();
  const member = doc.updated_by?.name ?? t('knowledge.someone');
  const who = doc.updated_by_agent ? t('knowledge.byAgent', { agent: doc.updated_by_agent.name, member }) : member;
  return {
    text: t('knowledge.updatedBy', {
      name: who,
      time: relativeTime(doc.updated_at, { locale, timeZone: me.timezone }),
    }),
    title: fullTime(doc.updated_at, { locale, timeZone: me.timezone }),
  };
}

function Backlinks({ docId }: { docId: string }) {
  const { t } = useI18n();
  const backlinks = useBacklinks(docId);
  if (!backlinks.items.length) return null;
  return (
    <section className="app-doc-section" aria-label={t('knowledge.backlinks')}>
      <h2 className="app-section-title">{t('knowledge.backlinks')}</h2>
      <ul className="app-list">
        {backlinks.items.map((item) => (
          <li key={item.id}>
            <a className="app-list-row" href={href(routeOf(item))}>
              <span className="app-file-icon">
                <ItemIcon item={item} />
              </span>
              <span className="app-list-main">
                <span className="app-list-title">{item.name}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where to go once the doc is archived: its folder, else the root of its space. */
const parentOf = (doc: Pick<KnowledgeDoc, 'folder_id' | 'space' | 'owner_id'>, me: string) =>
  doc.folder_id
    ? ({ page: 'folder', id: doc.folder_id } as const)
    : ({ page: 'knowledge', space: scopeOf({ space: doc.space, owner_id: doc.owner_id }, me) } as const);

function DocRead({ doc }: { doc: KnowledgeDoc }) {
  const { t } = useI18n();
  const me = useMe();
  const { menuFor, restore } = useItemMenu();
  const presence = usePresence(doc.id, 'viewing');
  const others = presence.filter((entry) => entry.member_id !== me.id);
  const [versions, setVersions] = useState(false);
  const { headings, onHeadings } = useHeadings();
  const content = useRef<HTMLDivElement | null>(null);
  const setContent = useCallback((element: HTMLDivElement | null) => {
    content.current = element;
  }, []);
  const wide = useMedia(WIDE);
  const item = docItem(doc);
  const updated = useUpdatedLine(doc);
  const { agentById } = usePeople();
  const agent = doc.agent_id ? agentById.get(doc.agent_id) : undefined;
  const go = (index: number) => goToHeading(content.current, index);
  const editable = canEdit(item);

  return (
    <Page
      width="list"
      header={
        <PageHeader
          title={doc.title}
          badge={
            <>
              {doc.is_template && <Badge>{t('knowledge.templateBadge')}</Badge>}
              {doc.archived_at && <Badge>{t('knowledge.archivedBadge')}</Badge>}
              {doc.access === 'viewer' && <Badge>{t('knowledge.readOnly')}</Badge>}
            </>
          }
          actions={<Presence items={others} />}
          primary={
            editable ? (
              <Button kind="primary" onClick={() => navigate({ page: 'doc', id: doc.id, edit: true })}>
                <Pencil size={icon.md} strokeWidth={icon.stroke} />
                {t('knowledge.edit')}
              </Button>
            ) : undefined
          }
          menu={[
            {
              label: t('knowledge.versions'),
              icon: <History size={icon.md} strokeWidth={icon.stroke} />,
              onClick: () => setVersions(true),
            },
            '-',
            ...menuFor(item, { afterArchive: () => navigate(parentOf(doc, me.id)) }),
          ]}
        />
      }
    >
      <div className={wide && headings.length > 1 ? 'app-doc-layout has-toc' : 'app-doc-layout'}>
        <div className="app-doc-main">
          <div className="app-doc-meta">
            <Crumbs scope={scopeOf(doc, me.id)} path={doc.path} />
            <span className="app-muted" title={updated.title}>
              {updated.text}
            </span>
            {doc.agent_id && (
              <Badge>{t('knowledge.agentFolderOf', { name: agent?.name ?? doc.path[0]?.name ?? '' })}</Badge>
            )}
          </div>
          {doc.archived_at && (
            <Banner
              tone="warning"
              action={
                canArchive(item) ? (
                  <Button size="sm" onClick={() => void restore(item)}>
                    {t('knowledge.restore')}
                  </Button>
                ) : undefined
              }
            >
              {t('knowledge.docArchived')}
            </Banner>
          )}
          {!wide && <DocToc headings={headings} onGo={go} collapsible />}
          {doc.content.trim() ? (
            <DocContent markdown={doc.content} onHeadings={onHeadings} contentRef={setContent} />
          ) : (
            <Empty
              icon={<Pencil />}
              title={t('knowledge.emptyDoc')}
              action={
                editable ? (
                  <Button onClick={() => navigate({ page: 'doc', id: doc.id, edit: true })}>
                    {t('knowledge.startWriting')}
                  </Button>
                ) : undefined
              }
            />
          )}
          <Backlinks docId={doc.id} />
          <Comments docId={doc.id} archived={!!doc.archived_at} />
        </div>
        {wide && headings.length > 1 && (
          <aside className="app-doc-aside">
            <DocToc headings={headings} onGo={go} />
          </aside>
        )}
      </div>
      {versions && <VersionsDrawer doc={doc} onClose={() => setVersions(false)} />}
    </Page>
  );
}

type SaveState = 'idle' | 'saving' | 'failed';

function DocEdit({ doc }: { doc: KnowledgeDoc }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const { memberById } = usePeople();
  /** What the edit started from: the version a save is based on. Reloading starts again. */
  const [start, setStart] = useState(() => ({ version: doc.version, title: doc.title, content: doc.content }));
  const [title, setTitle] = useState(doc.title);
  const [note, setNote] = useState('');
  const [changed, setChanged] = useState(false);
  const [state, setState] = useState<SaveState>('idle');
  const [failure, setFailure] = useState('');
  const [conflict, setConflict] = useState<ReturnType<typeof staleDetails>>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const editor = useRef<DocEditorHandle | null>(null);
  const presence = usePresence(doc.id, 'editing');
  const othersEditing = presence.filter((entry) => entry.member_id !== me.id && entry.state === 'editing');
  const dirty = changed || title !== start.title;
  const readRoute = { page: 'doc', id: doc.id } as const;

  useEffect(() => (dirty ? holdNavigation(setLeaving) : undefined), [dirty]);

  const timeOf = (iso: string) => relativeTime(iso, { locale, timeZone: me.timezone });

  const save = async (basedOn = start.version) => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setState('failed');
      setFailure(t('knowledge.titleRequired'));
      return;
    }
    setState('saving');
    setFailure('');
    try {
      const saved = await api.knowledge.docs.update(doc.id, {
        version: basedOn,
        title: nextTitle,
        content: editor.current?.markdown() ?? start.content,
        ...(note.trim() ? { change_note: note.trim() } : {}),
      });
      client.setQueryData(keys.doc(doc.id), saved);
      void client.invalidateQueries({ queryKey: keys.docVersions(doc.id) });
      void client.invalidateQueries({ queryKey: keys.docBacklinks(doc.id) });
      void refreshTree(client);
      setChanged(false);
      notify(saved.version === start.version ? t('knowledge.nothingToSave') : t('knowledge.saved'));
      navigate(readRoute, { replace: true, force: true });
    } catch (caught) {
      const stale =
        caught instanceof ApiClientError && caught.code === 'stale_version' ? staleDetails(caught.details) : null;
      if (stale) {
        setConflict(stale);
        setState('idle');
        void client.invalidateQueries({ queryKey: keys.doc(doc.id) });
        return;
      }
      setState('failed');
      setFailure(errorText(caught, t));
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Throws the draft away and edits the newest version. */
  const reload = async () => {
    setReloading(false);
    const latest = await api.knowledge.docs.get(doc.id).catch(() => null);
    if (!latest) return;
    client.setQueryData(keys.doc(doc.id), latest);
    setStart({ version: latest.version, title: latest.title, content: latest.content });
    setTitle(latest.title);
    setChanged(false);
    setConflict(null);
    setState('idle');
    setFailure('');
  };

  const cancel = () => (dirty ? setLeaving(href(readRoute)) : navigate(readRoute, { replace: true, force: true }));

  const savedBy = (id: string | null) =>
    id ? (memberById.get(id)?.name ?? t('knowledge.someone')) : t('knowledge.someone');
  const newer = !conflict && doc.version > start.version;
  const status =
    state === 'saving' ? (
      <StatusBadge status={t('knowledge.state.saving')} tone="info" />
    ) : state === 'failed' ? (
      <StatusBadge status={t('knowledge.state.failed')} tone="danger" />
    ) : dirty ? (
      <StatusBadge status={t('knowledge.state.unsaved')} tone="neutral" />
    ) : null;

  return (
    <Page
      width="reading"
      className="app-doc-editing"
      header={
        <PageHeader
          title={title.trim() || t('knowledge.untitled')}
          badge={status}
          actions={<Presence items={presence.filter((entry) => entry.member_id !== me.id)} />}
        />
      }
    >
      {conflict ? (
        <Banner
          tone="warning"
          action={
            <span className="app-inline-actions">
              <Button size="sm" onClick={() => setReloading(true)}>
                {t('knowledge.reload')}
              </Button>
              <Button size="sm" onClick={() => void save(conflict.version)}>
                {t('knowledge.saveAnyway')}
              </Button>
            </span>
          }
        >
          {t('knowledge.conflict', {
            name: savedBy(conflict.updatedBy),
            time: timeOf(conflict.updatedAt),
            version: conflict.version,
          })}
        </Banner>
      ) : newer ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={() => (dirty ? setReloading(true) : void reload())}>
              {t('knowledge.reload')}
            </Button>
          }
        >
          {t('knowledge.newerVersion', {
            name: doc.updated_by_agent?.name ?? doc.updated_by?.name ?? t('knowledge.someone'),
            time: timeOf(doc.updated_at),
          })}
        </Banner>
      ) : othersEditing.length ? (
        <Banner tone="info">
          {t('knowledge.alsoEditing', { names: othersEditing.map((entry) => entry.name).join('、') })}
        </Banner>
      ) : null}
      <Input
        className="app-doc-title-input"
        aria-label={t('knowledge.title')}
        value={title}
        maxLength={DOC_TITLE_MAX}
        placeholder={t('knowledge.untitled')}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            editor.current?.focus();
          }
        }}
      />
      <DocEditor
        key={start.version}
        docId={doc.id}
        markdown={start.content}
        handle={editor}
        onChange={() => setChanged(true)}
      />
      <div className="app-save-bar app-doc-save-bar">
        <Input
          className="app-doc-note"
          aria-label={t('knowledge.changeNote')}
          placeholder={t('knowledge.changeNotePlaceholder')}
          value={note}
          maxLength={CHANGE_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
        />
        {failure && (
          <span className="app-form-error" role="alert">
            {failure}
          </span>
        )}
        <span className="app-inline-actions">
          <Button onClick={cancel}>{t('common.cancel')}</Button>
          <Button kind="primary" loading={state === 'saving'} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </span>
      </div>
      {leaving !== null && (
        <ConfirmDialog
          danger
          title={t('knowledge.discardTitle')}
          confirmLabel={t('knowledge.discard')}
          cancelLabel={t('knowledge.keepEditing')}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            const to = leaving;
            setLeaving(null);
            setChanged(false);
            navigate(to, { force: true, replace: to === href(readRoute) });
          }}
        >
          {t('knowledge.discardBody')}
        </ConfirmDialog>
      )}
      {reloading && (
        <ConfirmDialog
          danger
          title={t('knowledge.reloadTitle')}
          confirmLabel={t('knowledge.reloadConfirm')}
          cancelLabel={t('knowledge.keepEditing')}
          onCancel={() => setReloading(false)}
          onConfirm={() => void reload()}
        >
          {t('knowledge.reloadBody')}
        </ConfirmDialog>
      )}
    </Page>
  );
}

export function DocPage({ id, edit }: { id: string; edit: boolean }) {
  const { t } = useI18n();
  const me = useMe();
  const doc = useDoc(id);
  const data = doc.data;
  // Once editing started it stays in the editor, even if the doc is archived or its share taken
  // away meanwhile: the draft is never dropped for that (the save then says why it cannot).
  const [editing, setEditing] = useState(false);
  const mayEdit = !!data && canEdit(docItem(data));
  useEffect(() => setEditing(edit && (editing || mayEdit)), [edit, editing, mayEdit]);

  // Show where it lives in the directory: its space, the folders above it open.
  const pathKey = data?.path.map((entry) => entry.id).join('/');
  useEffect(() => {
    if (!data) return;
    setKnowledgeScope(scopeOf(data, me.id));
    revealFolders(data.path.map((entry) => entry.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, data?.space, data?.owner_id, pathKey, me.id]);

  if (doc.isPending) {
    return (
      <Page width="reading" header={<PageHeader title="" />}>
        <Skeleton lines={10} />
      </Page>
    );
  }
  if (doc.isError || !data) {
    const missing = doc.error instanceof ApiClientError && (doc.error.status === 404 || doc.error.status === 403);
    return (
      <Page width="reading" header={<PageHeader title={t('nav.knowledge')} />}>
        {missing ? (
          <Empty
            icon={<FileQuestion />}
            title={t('knowledge.docMissing')}
            description={t('knowledge.docMissingHint')}
            action={<Button onClick={() => navigate({ page: 'knowledge' })}>{t('knowledge.backToKnowledge')}</Button>}
          />
        ) : (
          <ErrorBox onRetry={() => void doc.refetch()}>{errorText(doc.error, t)}</ErrorBox>
        )}
      </Page>
    );
  }
  if (edit && (editing || mayEdit)) return <DocEdit doc={data} />;
  return <DocRead doc={data} />;
}
