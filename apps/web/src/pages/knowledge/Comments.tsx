/**
 * 评论 (KNOW-08): everyone who reads the doc may comment; `@` picks members to mention, who are
 * told through the notification center. Only who wrote a comment edits or deletes it.
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { MessageSquare } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ConfirmDialog, ErrorBox, Menu, Skeleton, TextArea } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { COMMENT_BODY_MAX, type KnowledgeComment, type MemberRef } from '@greenhouse/contract';
import { useMe } from '../../app/session';
import { useDocComments } from '../../data/knowledge';
import { usePeople } from '../../data/people';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { fullTime, relativeTime } from '../../lib/time';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { DocContent } from './DocContent';
import { mentionAt, withMentions } from './helpers';

/** A text box that offers members after `@` and remembers who was picked. */
function CommentBox({
  label,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const [text, setText] = useState(initial);
  const [picked, setPicked] = useState<MemberRef[]>([]);
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const people = useQuery({
    queryKey: ['members', 'directory', at?.query ?? ''],
    queryFn: () => api.members.directory(at?.query || undefined),
    enabled: at !== null,
    staleTime: 60_000,
  });
  const options = (people.data?.items ?? []).filter((member) => member.id !== me.id).slice(0, 8);

  const pick = (member: MemberRef) => {
    if (!at) return;
    const before = text.slice(0, at.start);
    const after = text.slice(at.start + 1 + at.query.length);
    const next = `${before}@${member.name} ${after}`;
    setText(next);
    setPicked((list) => [...list.filter((other) => other.id !== member.id), { id: member.id, name: member.name }]);
    setAt(null);
    requestAnimationFrame(() => {
      const caret = before.length + member.name.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };

  const submit = async () => {
    const body = withMentions(
      text.trim(),
      picked.filter((member) => text.includes(`@${member.name}`)),
    );
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(body);
      setText('');
      setPicked([]);
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (at && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((active + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(options[active] ?? options[0]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setAt(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="app-comment-box">
      <div className="app-comment-input">
        <TextArea
          ref={input}
          aria-label={label}
          placeholder={t('knowledge.commentPlaceholder')}
          value={text}
          rows={2}
          maxRows={10}
          maxLength={COMMENT_BODY_MAX}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setError('');
            setAt(mentionAt(event.target.value, event.target.selectionStart ?? event.target.value.length));
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setAt(null), 150)}
        />
        {at && options.length > 0 && (
          <ul className="app-mention-list" role="listbox" aria-label={t('knowledge.mention')}>
            {options.map((member, index) => (
              <li
                key={member.id}
                role="option"
                aria-selected={index === active}
                className={cx('app-mention-option', index === active && 'is-active')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(member)}
              >
                <MemberAvatar name={member.name} url={member.avatar_url} size={20} />
                <span>{member.name}</span>
                <span className="app-mention-hint">{member.email}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="app-inline-actions">
        {onCancel && <Button onClick={onCancel}>{t('common.cancel')}</Button>}
        <Button
          kind={onCancel ? 'primary' : 'secondary'}
          loading={busy}
          disabled={!text.trim()}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** A comment as typed again: mention links back to `@Name`, so editing keeps them. */
const editable = (comment: KnowledgeComment) =>
  comment.body.replace(
    /\[@((?:\\.|[^\]\\])*)\]\(member:[^)\s]+\)/g,
    (_m, name: string) => `@${name.replace(/\\([\\[\]])/g, '$1')}`,
  );
const mentionedIn = (comment: KnowledgeComment): MemberRef[] =>
  [...comment.body.matchAll(/\[@((?:\\.|[^\]\\])*)\]\(member:([^)\s]+)\)/g)].map((match) => ({
    id: match[2]!,
    name: match[1]!.replace(/\\([\\[\]])/g, '$1'),
  }));

function CommentItem({ docId, comment }: { docId: string; comment: KnowledgeComment }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { memberById } = usePeople();
  const timeZone = me.timezone;
  const author = comment.agent
    ? t('knowledge.byAgent', { agent: comment.agent.name, member: comment.created_by?.name ?? '' })
    : (comment.created_by?.name ?? t('knowledge.someone'));
  const refresh = () => client.invalidateQueries({ queryKey: keys.docComments(docId) });
  return (
    <li className="app-comment">
      <MemberAvatar
        name={comment.created_by?.name ?? '?'}
        url={comment.created_by ? memberById.get(comment.created_by.id)?.avatar_url : null}
        size={28}
      />
      <div className="app-comment-main">
        <div className="app-comment-head">
          <strong>{author}</strong>
          <time dateTime={comment.created_at} title={fullTime(comment.created_at, { locale, timeZone })}>
            {relativeTime(comment.created_at, { locale, timeZone })}
          </time>
          {comment.edited && <span className="app-muted">{t('knowledge.edited')}</span>}
          {comment.mine && !editing && (
            <Menu
              label={t('row.actionsFor', { name: t('knowledge.comment') })}
              items={[
                { label: t('knowledge.editComment'), onClick: () => setEditing(true) },
                '-',
                { label: t('row.delete'), danger: true, onClick: () => setDeleting(true) },
              ]}
            />
          )}
        </div>
        {editing ? (
          <EditComment docId={docId} comment={comment} onDone={() => setEditing(false)} />
        ) : (
          <DocContent markdown={comment.body} className="app-comment-body" />
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          danger
          title={t('knowledge.deleteCommentTitle')}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.knowledge.docs.removeComment(docId, comment.id).then(refresh);
          }}
        >
          {t('knowledge.deleteCommentBody')}
        </ConfirmDialog>
      )}
    </li>
  );
}

function EditComment({ docId, comment, onDone }: { docId: string; comment: KnowledgeComment; onDone: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const known = mentionedIn(comment);
  return (
    <CommentBox
      label={t('knowledge.editComment')}
      initial={editable(comment)}
      submitLabel={t('common.save')}
      onCancel={onDone}
      onSubmit={async (body) => {
        // Mentions kept from before stay links even if not picked again.
        await api.knowledge.docs.editComment(docId, comment.id, withMentions(body, known));
        await client.invalidateQueries({ queryKey: keys.docComments(docId) });
        onDone();
      }}
    />
  );
}

export function Comments({ docId, archived }: { docId: string; archived: boolean }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const comments = useDocComments(docId);
  return (
    <section className="app-doc-section" aria-label={t('knowledge.comments')}>
      <h2 className="app-section-title">
        {t('knowledge.comments')}
        {comments.items.length > 0 && <span className="app-count">{comments.items.length}</span>}
      </h2>
      {comments.isPending ? (
        <Skeleton lines={2} />
      ) : comments.isError ? (
        <ErrorBox onRetry={() => void comments.refetch()}>{errorText(comments.error, t)}</ErrorBox>
      ) : comments.items.length ? (
        <ul className="app-comments">
          {comments.items.map((comment) => (
            <CommentItem key={comment.id} docId={docId} comment={comment} />
          ))}
        </ul>
      ) : (
        <p className="app-muted app-empty-line">
          <MessageSquare size={icon.sm} aria-hidden />
          {t('knowledge.noComments')}
        </p>
      )}
      {comments.hasNextPage && (
        <Button kind="ghost" loading={comments.isFetchingNextPage} onClick={() => void comments.fetchNextPage()}>
          {t('common.more')}
        </Button>
      )}
      {!archived && (
        <CommentBox
          label={t('knowledge.addComment')}
          submitLabel={t('knowledge.postComment')}
          onSubmit={async (body) => {
            await api.knowledge.docs.comment(docId, body);
            await client.invalidateQueries({ queryKey: keys.docComments(docId) });
          }}
        />
      )}
    </section>
  );
}
