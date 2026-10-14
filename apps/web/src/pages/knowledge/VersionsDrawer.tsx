/**
 * 版本历史 (KNOW-07): every save, newest first, with who wrote it (and the Agent that wrote it for
 * them) and its note. A version opens in the same drawer: its content, or what changed from the
 * one before by line or by word; restoring writes it again as a new version.
 */

import { useState } from 'react';
import { ChevronLeft, History } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Empty, ErrorBox, Overlay, OverlayActions, Segmented, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { DocDiff, DocVersion, KnowledgeDoc } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMe } from '../../app/session';
import { useNotify } from '../../app/notify';
import { refreshTree, useDocDiff, useDocVersion, useDocVersions } from '../../data/knowledge';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { fullTime, relativeTime } from '../../lib/time';
import { DocContent } from './DocContent';
import { canEdit, docItem } from './helpers';

/** What changed between two versions, as the API cut it into hunks. */
export function DiffView({ diff }: { diff: DocDiff }) {
  const { t } = useI18n();
  const unit = diff.mode === 'line' ? t('knowledge.lines') : t('knowledge.words');
  if (!diff.hunks.length && !diff.title) return <p className="app-muted">{t('knowledge.noChanges')}</p>;
  return (
    <div className="app-diff">
      <p className="app-diff-summary">
        <span className="is-insert">+{diff.added}</span>
        <span className="is-delete">−{diff.removed}</span>
        <span className="app-muted">{unit}</span>
      </p>
      {diff.title && (
        <p className="app-diff-title">
          {t('knowledge.titleChange')}
          <del>{diff.title.from}</del>→<ins>{diff.title.to}</ins>
        </p>
      )}
      {diff.hunks.map((hunk, index) => (
        <div key={index} className="app-diff-hunk">
          <p className="app-diff-where">{t('knowledge.atLine', { from: hunk.from_line, to: hunk.to_line })}</p>
          {diff.mode === 'line' ? (
            <div className="app-diff-lines">
              {hunk.parts.flatMap((part, partIndex) =>
                part.text
                  .replace(/\n$/, '')
                  .split('\n')
                  .map((line, lineIndex) => (
                    <div key={`${partIndex}:${lineIndex}`} className={cx('app-diff-line', `is-${part.op}`)}>
                      <span className="app-diff-mark" aria-hidden>
                        {part.op === 'insert' ? '+' : part.op === 'delete' ? '−' : ' '}
                      </span>
                      {part.op === 'insert' ? (
                        <ins>{line}</ins>
                      ) : part.op === 'delete' ? (
                        <del>{line}</del>
                      ) : (
                        <span>{line}</span>
                      )}
                    </div>
                  )),
              )}
            </div>
          ) : (
            <p className="app-diff-words">
              {hunk.parts.map((part, partIndex) =>
                part.op === 'insert' ? (
                  <ins key={partIndex}>{part.text}</ins>
                ) : part.op === 'delete' ? (
                  <del key={partIndex}>{part.text}</del>
                ) : (
                  <span key={partIndex}>{part.text}</span>
                ),
              )}
            </p>
          )}
        </div>
      ))}
      {diff.truncated && <p className="app-muted">{t('knowledge.diffTruncated')}</p>}
    </div>
  );
}

function author(version: DocVersion, t: ReturnType<typeof useI18n>['t']) {
  const member = version.created_by?.name ?? t('knowledge.someone');
  return version.agent ? t('knowledge.byAgent', { agent: version.agent.name, member }) : member;
}

function VersionDetail({ doc, version, onBack }: { doc: KnowledgeDoc; version: DocVersion; onBack: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const [view, setView] = useState<'content' | 'changes'>(version.version > 1 ? 'changes' : 'content');
  const [mode, setMode] = useState<'line' | 'word'>('line');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const detail = useDocVersion(doc.id, version.version);
  const diff = useDocDiff(doc.id, version.version - 1, version.version, mode, view === 'changes');
  const current = version.version === doc.version;

  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await api.knowledge.docs.restoreVersion(doc.id, version.version, doc.version);
      client.setQueryData(keys.doc(doc.id), saved);
      void client.invalidateQueries({ queryKey: keys.docVersions(doc.id) });
      void refreshTree(client);
      notify(t('knowledge.versionRestored', { version: version.version }));
      onBack();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'stale_version') {
        void client.invalidateQueries({ queryKey: keys.doc(doc.id) });
        setError(t('knowledge.restoreStale'));
      } else setError(errorText(caught, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-overlay-stack">
      <div>
        <Button kind="ghost" size="sm" onClick={onBack}>
          <ChevronLeft size={icon.sm} strokeWidth={icon.stroke} />
          {t('knowledge.allVersions')}
        </Button>
      </div>
      <div className="app-version-head">
        <strong>{t('knowledge.version', { version: version.version })}</strong>
        {current && <Badge tone="success">{t('knowledge.current')}</Badge>}
        <span className="app-muted">
          {author(version, t)} ·{' '}
          <time dateTime={version.created_at} title={fullTime(version.created_at, { locale, timeZone: me.timezone })}>
            {relativeTime(version.created_at, { locale, timeZone: me.timezone })}
          </time>
        </span>
      </div>
      {version.change_note && <p className="app-version-note">{version.change_note}</p>}
      <div className="app-toolbar">
        {version.version > 1 && (
          <Segmented
            label={t('knowledge.versionView')}
            items={[
              { value: 'changes', label: t('knowledge.changes') },
              { value: 'content', label: t('knowledge.content') },
            ]}
            value={view}
            onChange={(value) => setView(value as 'content' | 'changes')}
          />
        )}
        {view === 'changes' && (
          <Segmented
            label={t('knowledge.diffMode')}
            items={[
              { value: 'line', label: t('knowledge.byLine') },
              { value: 'word', label: t('knowledge.byWord') },
            ]}
            value={mode}
            onChange={(value) => setMode(value as 'line' | 'word')}
          />
        )}
      </div>
      {view === 'content' ? (
        detail.isPending ? (
          <Skeleton lines={6} />
        ) : detail.isError ? (
          <ErrorBox onRetry={() => void detail.refetch()}>{errorText(detail.error, t)}</ErrorBox>
        ) : (
          <>
            <h3 className="app-version-title">{detail.data.title}</h3>
            <DocContent markdown={detail.data.content} />
          </>
        )
      ) : diff.isPending ? (
        <Skeleton lines={6} />
      ) : diff.isError ? (
        <ErrorBox onRetry={() => void diff.refetch()}>{errorText(diff.error, t)}</ErrorBox>
      ) : (
        <DiffView diff={diff.data} />
      )}
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      {!current && canEdit(docItem(doc)) && (
        <OverlayActions>
          <Button kind="primary" loading={busy} onClick={() => void restore()}>
            {t('knowledge.restoreVersion', { version: version.version })}
          </Button>
        </OverlayActions>
      )}
    </div>
  );
}

export function VersionsDrawer({ doc, onClose }: { doc: KnowledgeDoc; onClose: () => void }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const versions = useDocVersions(doc.id);
  const [open, setOpen] = useState<DocVersion | null>(null);
  return (
    <Overlay title={t('knowledge.versions')} help={t('knowledge.versionsHelp')} onClose={onClose}>
      {open ? (
        <VersionDetail key={open.version} doc={doc} version={open} onBack={() => setOpen(null)} />
      ) : versions.isPending ? (
        <Skeleton lines={6} />
      ) : versions.isError ? (
        <ErrorBox onRetry={() => void versions.refetch()}>{errorText(versions.error, t)}</ErrorBox>
      ) : !versions.items.length ? (
        <Empty icon={<History />} title={t('knowledge.noVersions')} />
      ) : (
        <ul className="app-list" aria-label={t('knowledge.versions')}>
          {versions.items.map((version) => (
            <li key={version.version}>
              <button type="button" className="app-list-row" onClick={() => setOpen(version)}>
                <span className="app-order">{version.version}</span>
                <span className="app-list-main">
                  <span className="app-list-title">
                    {version.change_note || version.title}
                    {version.version === doc.version && (
                      <>
                        {' '}
                        <Badge tone="success">{t('knowledge.current')}</Badge>
                      </>
                    )}
                  </span>
                  <span className="app-list-meta">{author(version, t)}</span>
                </span>
                <time
                  className="app-list-time"
                  dateTime={version.created_at}
                  title={fullTime(version.created_at, { locale, timeZone: me.timezone })}
                >
                  {relativeTime(version.created_at, { locale, timeZone: me.timezone })}
                </time>
              </button>
            </li>
          ))}
          {versions.hasNextPage && (
            <li>
              <Button kind="ghost" loading={versions.isFetchingNextPage} onClick={() => void versions.fetchNextPage()}>
                {t('common.more')}
              </Button>
            </li>
          )}
        </ul>
      )}
    </Overlay>
  );
}
