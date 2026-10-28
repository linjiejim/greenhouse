/**
 * Memory (browser place): what my assistant remembers, grouped in use / resting / archived. A row
 * opens its edit dialog; its menu pins, archives or restores, and deletes after a confirm. New
 * memories come only from the assistant (the `memory` tool), so the empty state says how to ask.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { Icon } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { NativeMenu, menuSections } from '../../ui/menu.web';
import { DialogBody, Overlay } from '../../ui/overlay.web';
import { Place, PlaceEmpty } from '../../ui/place.web';
import { toast } from '../../ui/toast';
import { deleteMemory, listMemories, updateMemory } from './api';
import {
  archiveStatus,
  draftOf,
  draftProblem,
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  memorySections,
  patchBody,
  type Memory,
  type MemoryCategory,
  type MemoryDraft,
} from './model';
import '../app-pages.css';

export function MemoryScreen({ title }: { title: string }) {
  const t = useT();
  const list = useResource(useCallback(() => listMemories(), []));
  const [editing, setEditing] = useState<Memory | null>(null);
  useEffect(() => {
    const refresh = () => void list.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const sections = useMemo(() => (list.data ? memorySections(list.data.memories) : null), [list.data]);

  const change = async (memory: Memory, body: Parameters<typeof updateMemory>[1], done: string) => {
    const current = captureIdentity();
    const r = await updateMemory(memory.id, body);
    if (!current()) return;
    if (!r.ok) alertError(t('appPages.memory.saveFailed'), r.message);
    else toast(done);
    void list.refresh();
  };
  const remove = async (memory: Memory) => {
    const current = captureIdentity();
    const ok = await confirmAction({
      title: t('appPages.memory.deleteTitle', { title: memory.title }),
      message: t('appPages.memory.deleteHint'),
      confirmLabel: t('appPages.memory.delete'),
      destructive: true,
    });
    if (!ok || !current()) return;
    const r = await deleteMemory(memory.id);
    if (!current()) return;
    if (!r.ok) alertError(t('appPages.memory.deleteFailed'), r.message);
    else toast(t('appPages.memory.deleted'));
    void list.refresh();
  };
  const act = (id: string, memory: Memory) => {
    if (id === 'edit') setEditing(memory);
    if (id === 'pin')
      void change(
        memory,
        { pinned: !memory.pinned },
        t(memory.pinned ? 'appPages.memory.unpinnedDone' : 'appPages.memory.pinnedDone'),
      );
    if (id === 'archive') {
      const status = archiveStatus(memory);
      void change(
        memory,
        { status },
        t(status === 'archived' ? 'appPages.memory.archivedDone' : 'appPages.memory.restored'),
      );
    }
    if (id === 'delete') void remove(memory);
  };

  return (
    <Place
      title={title}
      actions={
        <button onClick={() => void list.refresh()} disabled={list.loading} aria-label={t('common.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      }
    >
      <div className="gh-place-scroll">
        {!sections ? (
          list.error?.status === 403 ? (
            <PlaceEmpty
              icon="brain"
              title={t('appPages.memory.unavailable')}
              message={t('appPages.memory.unavailableHint')}
            />
          ) : (
            <PlaceEmpty
              loading={list.loading}
              error={list.error ? list.error.message || t('places.pluginError') : null}
              retry={() => void list.refresh()}
            />
          )
        ) : !sections.length ? (
          <PlaceEmpty icon="brain" title={t('appPages.memory.empty')} message={t('appPages.memory.emptyHint')} />
        ) : (
          <div className="gh-app-page" data-testid="memory-page">
            <p className="gh-hint">{t('appPages.memory.intro')}</p>
            {sections.map(({ group, items }) => (
              <React.Fragment key={group}>
                <div className="gh-app-section">
                  <h2>{t(`appPages.memory.group.${group}`)}</h2>
                  <p className="gh-hint">{t(`appPages.memory.groupHint.${group}`)}</p>
                </div>
                <ul className="gh-resource-list" data-testid={`memory-${group}`}>
                  {items.map((memory) => (
                    <li key={memory.id}>
                      <button className="gh-app-row-main" aria-label={memory.title} onClick={() => setEditing(memory)}>
                        <span className="gh-resource-icon">
                          <Icon name={memory.pinned ? 'pin' : 'brain'} size={18} color="var(--gh-accent-text)" />
                        </span>
                        <span className="gh-resource-body">
                          <strong>{memory.title}</strong>
                          <p>{memory.content}</p>
                          <span className="gh-resource-tags">
                            <span>{t(`appPages.memory.category.${memory.category}`)}</span>
                            {memory.pinned ? <span>{t('appPages.memory.pinned')}</span> : null}
                          </span>
                        </span>
                      </button>
                      <div className="gh-resource-meta">
                        <small>
                          {memory.last_used_at
                            ? t('appPages.memory.used', { when: relativeTimeNow(memory.last_used_at) })
                            : t('appPages.memory.changed', { when: relativeTimeNow(memory.updated_at) })}
                        </small>
                      </div>
                      <NativeMenu
                        title={memory.title}
                        items={menuSections([
                          [
                            { id: 'edit', title: t('appPages.memory.edit'), icon: 'pen' },
                            {
                              id: 'pin',
                              title: t(memory.pinned ? 'appPages.memory.unpin' : 'appPages.memory.pin'),
                              icon: memory.pinned ? 'pinOff' : 'pin',
                            },
                            {
                              id: 'archive',
                              title: t(
                                memory.status === 'active' ? 'appPages.memory.archive' : 'appPages.memory.restore',
                              ),
                              icon: 'archive',
                            },
                          ],
                          [{ id: 'delete', title: t('appPages.memory.delete'), icon: 'trash', destructive: true }],
                        ])}
                        onSelect={(id) => act(id, memory)}
                      >
                        <button
                          className="gh-icon-button"
                          aria-label={t('appPages.actionsFor', { name: memory.title })}
                        >
                          <Icon name="more" size={16} />
                        </button>
                      </NativeMenu>
                    </li>
                  ))}
                </ul>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
      {editing ? (
        <MemoryDialog
          memory={editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            toast(t('appPages.memory.saved'));
            void list.refresh();
          }}
          remove={() => {
            setEditing(null);
            void remove(editing);
          }}
        />
      ) : null}
    </Place>
  );
}

function MemoryDialog({
  memory,
  close,
  saved,
  remove,
}: {
  memory: Memory;
  close: () => void;
  saved: () => void;
  remove: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<MemoryDraft>(() => draftOf(memory));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<MemoryDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const body = patchBody(memory, draft);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const problem = draftProblem(draft);
    if (problem) {
      setError(
        t(`appPages.memory.problem.${problem}`, {
          max: problem === 'titleLong' ? MEMORY_TITLE_MAX : MEMORY_CONTENT_MAX,
        }),
      );
      return;
    }
    if (!Object.keys(body).length) return close();
    const current = captureIdentity();
    setBusy(true);
    const r = await updateMemory(memory.id, body);
    if (!current()) return;
    setBusy(false);
    // the station's words name what it refused (a secret, a phone number)
    if (!r.ok) setError(r.message || t('appPages.memory.saveFailed'));
    else saved();
  };
  const titleLength = draft.title.trim().length;
  const contentLength = draft.content.trim().length;
  return (
    <Overlay label={t('appPages.memory.editTitle')} onClose={close} testID="memory-edit" size="md">
      <form
        className="gh-dialog-form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      >
        <DialogBody
          title={t('appPages.memory.editTitle')}
          actions={
            <button type="button" className="gh-icon-button" aria-label={t('common.close')} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          }
          footer={
            <>
              <div className="gh-dialog-footer-lead">
                <button type="button" className="gh-link-button gh-danger" onClick={remove}>
                  {t('appPages.memory.delete')}
                </button>
              </div>
              <button type="button" className="gh-secondary-button" onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="gh-primary" disabled={busy}>
                {t('common.save')}
              </button>
            </>
          }
        >
          <div className="gh-form">
            <div className="gh-field">
              <label htmlFor="memory-title">
                {t('appPages.memory.title')}
                <small data-over={titleLength > MEMORY_TITLE_MAX || undefined}>
                  {titleLength} / {MEMORY_TITLE_MAX}
                </small>
              </label>
              <input id="memory-title" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
              <p className="gh-hint">{t('appPages.memory.titleHint')}</p>
            </div>
            <div className="gh-field">
              <label htmlFor="memory-content">
                {t('appPages.memory.content')}
                <small data-over={contentLength > MEMORY_CONTENT_MAX || undefined}>
                  {contentLength} / {MEMORY_CONTENT_MAX}
                </small>
              </label>
              <textarea
                id="memory-content"
                rows={8}
                value={draft.content}
                onChange={(e) => set({ content: e.target.value })}
              />
            </div>
            <div className="gh-field">
              <label htmlFor="memory-kind">{t('appPages.memory.kind')}</label>
              <select
                id="memory-kind"
                value={draft.category}
                onChange={(e) => set({ category: e.target.value as MemoryCategory })}
              >
                {MEMORY_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {t(`appPages.memory.category.${category}`)}
                  </option>
                ))}
              </select>
            </div>
            <label className="gh-check">
              <input type="checkbox" checked={draft.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
              <span>
                {t('appPages.memory.pin')}
                <small>{t('appPages.memory.pinHint')}</small>
              </span>
            </label>
            {error ? (
              <p role="alert" className="gh-error">
                {error}
              </p>
            ) : null}
          </div>
        </DialogBody>
      </form>
    </Overlay>
  );
}
