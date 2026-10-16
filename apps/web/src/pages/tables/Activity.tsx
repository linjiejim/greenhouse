/**
 * A record's comments and history, newest first (TBL-09), and the comment box: `@` suggests
 * members, and a mention is saved as `[@Name](member:<id>)` so the server can tell them.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button, ErrorBox, IconButton, Skeleton, TextArea } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  formatCell,
  type Base,
  type BaseTable,
  type KnowledgeComment,
  type MemberSummary,
  type RecordActivityItem,
  type RecordEvent,
} from '@greenhouse/contract';
import { useSession } from '../../app/session';
import { usePeople } from '../../data/people';
import { tablesKeys, useActivity } from '../../data/tables';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { fullTime, relativeTime } from '../../lib/time';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { tablesError } from './errors';
import type { CellLookups } from './model';

const MENTION = /\[@((?:\\.|[^\]\\\n])*)\]\(member:(mbr_[0-9A-Za-z]+)\)/g;

/** Plain text with mention chips. */
function CommentBody({ body }: { body: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    if (match.index! > last) parts.push(body.slice(last, match.index));
    parts.push(
      <span key={match.index} className="app-tb-mention">
        @{match[1]!.replace(/\\(.)/g, '$1')}
      </span>,
    );
    last = match.index! + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <p className="app-tb-comment-body">{parts}</p>;
}

/** Shows `[@Name](member:id)` as `@Name` while writing; turns it back when sending. */
const toEditable = (body: string, known: Map<string, string>) =>
  body.replace(MENTION, (_match, name: string, id: string) => {
    known.set(name, id);
    return `@${name}`;
  });
const toMarkdown = (text: string, known: Map<string, string>) => {
  let out = text;
  for (const [name, id] of [...known].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(`@${name}`).join(`[@${name.replace(/[[\]\\]/g, '\\$&')}](member:${id})`);
  }
  return out;
};

/** A textarea where `@` suggests members. */
function CommentBox({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (markdown: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const { members } = usePeople();
  const known = useRef(new Map<string, string>());
  const [text, setText] = useState(() => toEditable(initial, known.current));
  const [caret, setCaret] = useState(text.length);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const query = /@([^\s@]{0,20})$/.exec(text.slice(0, caret));
  const suggestions = query
    ? members.filter((member) => member.name.toLowerCase().includes(query[1]!.toLowerCase())).slice(0, 6)
    : [];
  const pick = (member: MemberSummary) => {
    if (!query) return;
    const start = caret - query[0].length;
    const next = `${text.slice(0, start)}@${member.name} ${text.slice(caret)}`;
    known.current.set(member.name, member.id);
    setText(next);
    const at = start + member.name.length + 2;
    setCaret(at);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  };
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(toMarkdown(text.trim(), known.current));
      setText('');
      setCaret(0);
    } catch (failure) {
      setError(tablesError(failure, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-tb-comment-box">
      <TextArea
        ref={box}
        rows={2}
        maxRows={8}
        aria-label={t('tables.activity.placeholder')}
        placeholder={t('tables.activity.placeholder')}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (suggestions.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              pick(suggestions[active]!);
              return;
            }
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul className="app-tb-mentions" role="listbox" aria-label={t('tables.activity.mention')}>
          {suggestions.map((member, index) => (
            <li
              key={member.id}
              role="option"
              aria-selected={index === active}
              className={cx(index === active && 'is-active')}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(member);
              }}
            >
              <MemberAvatar name={member.name} url={member.avatar_url} size={20} />
              <span>{member.name}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="app-tb-comment-actions">
        {onCancel && (
          <Button size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button size="sm" kind="primary" loading={busy} disabled={!text.trim()} onClick={() => void send()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function EventItem({ event, table, lookups }: { event: RecordEvent; table: BaseTable; lookups: CellLookups }) {
  const { t } = useI18n();
  const name = event.actor.name || t('tables.activity.someone');
  const words = t(`tables.activity.${event.type}`, { name });
  const text = (fieldId: string, value: unknown) => {
    const field = table.fields.find((entry) => entry.id === fieldId);
    if (!field) return Array.isArray(value) ? value.join(', ') : String(value ?? '');
    return formatCell(field, value, {
      timeZone: lookups.timeZone,
      memberName: (id) => lookups.members.get(id)?.name,
      linkedTitle: (id) => lookups.linked[id]?.title,
      fileName: (id) => lookups.files[id]?.name ?? '',
    });
  };
  return (
    <div className="app-tb-event">
      <span>{words}</span>
      {event.type === 'updated' && event.changes.length > 0 && (
        <ul className="app-tb-changes">
          {event.changes.map((change) => (
            <li key={change.field}>
              {t('tables.activity.change', {
                field: change.name,
                before: text(change.field, change.before) || t('tables.record.empty'),
                after: text(change.field, change.after) || t('tables.record.empty'),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  recordId,
  canRemove,
}: {
  comment: KnowledgeComment;
  recordId: string;
  canRemove: boolean;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: tablesKeys.activity(recordId) });
  if (editing) {
    return (
      <CommentBox
        initial={comment.body}
        submitLabel={t('tables.activity.saveComment')}
        onCancel={() => setEditing(false)}
        onSubmit={async (body) => {
          await api.tables.records.editComment(recordId, comment.id, body);
          setEditing(false);
          await refresh();
        }}
      />
    );
  }
  return (
    <div className="app-tb-comment">
      <CommentBody body={comment.body} />
      {(comment.mine || canRemove) && (
        <span className="app-tb-comment-tools">
          {comment.mine && (
            <IconButton size="sm" label={t('tables.activity.editComment')} onClick={() => setEditing(true)}>
              <Pencil size={icon.sm} strokeWidth={icon.stroke} />
            </IconButton>
          )}
          <IconButton
            size="sm"
            label={t('tables.activity.deleteComment')}
            onClick={() => void api.tables.records.removeComment(recordId, comment.id).then(refresh)}
          >
            <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
          </IconButton>
        </span>
      )}
    </div>
  );
}

export function Activity({
  base,
  table,
  recordId,
  lookups,
}: {
  base: Base;
  table: BaseTable;
  recordId: string;
  lookups: CellLookups;
}) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const { memberById } = usePeople();
  const activity = useActivity(recordId);
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  const merged: CellLookups = useMemo(
    () => ({ ...lookups, linked: { ...lookups.linked, ...activity.data?.linked } }),
    [lookups, activity.data?.linked],
  );
  const author = (item: RecordActivityItem) =>
    item.kind === 'comment'
      ? { id: item.created_by?.id ?? '', name: item.created_by?.name ?? t('tables.activity.someone') }
      : { id: item.actor.id ?? '', name: item.actor.name || t('tables.activity.someone') };
  return (
    <section className="app-tb-activity" aria-label={t('tables.activity.title')}>
      <h3 className="app-section-title">{t('tables.activity.title')}</h3>
      <CommentBox
        submitLabel={t('tables.activity.send')}
        onSubmit={async (body) => {
          await api.tables.records.comment(recordId, body);
          await queryClient.invalidateQueries({ queryKey: tablesKeys.activity(recordId) });
        }}
      />
      {activity.isPending ? (
        <Skeleton lines={3} />
      ) : activity.isError ? (
        <ErrorBox onRetry={() => void activity.refetch()}>{tablesError(activity.error, t)}</ErrorBox>
      ) : (
        <ol className="app-tb-activity-list">
          {activity.data.items.map((item) => {
            const who = author(item);
            const person = memberById.get(who.id);
            return (
              <li key={`${item.kind}:${item.id}`} className={cx('app-tb-activity-item', `is-${item.kind}`)}>
                <MemberAvatar name={who.name} url={person?.avatar_url} size={24} />
                <div className="app-tb-activity-main">
                  <div className="app-tb-activity-head">
                    {item.kind === 'comment' && <span className="app-tb-activity-name">{who.name}</span>}
                    <time dateTime={item.created_at} title={fullTime(item.created_at, { locale, timeZone })}>
                      {relativeTime(item.created_at, { locale, timeZone })}
                    </time>
                    {item.kind === 'comment' && item.edited && (
                      <span className="app-muted">{t('tables.activity.edited')}</span>
                    )}
                  </div>
                  {item.kind === 'comment' ? (
                    <CommentItem comment={item} recordId={recordId} canRemove={base.access === 'owner'} />
                  ) : (
                    <EventItem event={item} table={table} lookups={merged} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
