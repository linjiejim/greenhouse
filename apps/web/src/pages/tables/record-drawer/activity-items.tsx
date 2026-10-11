/**
 * One row of a record's activity: a comment (author, Markdown body with
 * mention chips, edit / delete for who may) or a history event (who, through
 * what — person / agent / automation / form / import / app — and the field
 * changes the server let this reader see, rendered with the shared
 * `FieldValue`).
 */

import type { ReactNode } from 'react';
import type { TableRecordActorKind } from '@greenhouse/types/tables';
import { Avatar, IconButton, Tag } from '../../../components/ui';
import { Markdown } from '../../../components/markdown';
import { FieldValue, type TableUsersById } from '../../../components/tables/field-value';
import {
  AppWindow,
  ArrowRight,
  Bot,
  FileSpreadsheet,
  FileText,
  History,
  Pencil,
  Settings,
  Trash2,
  User,
  Zap,
  type LucideIcon,
} from '../../../lib/icons';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { formatDate } from '../../../lib/utils';
import type { TableField, TableRecordCommentView, TableRecordEventView } from '../../../lib/api/tables';

const ACTOR_KIND: Record<
  TableRecordActorKind,
  { icon: LucideIcon; tone: 'neutral' | 'primary' | 'info' | 'success' | 'warning' }
> = {
  user: { icon: User, tone: 'neutral' },
  agent: { icon: Bot, tone: 'info' },
  automation: { icon: Zap, tone: 'primary' },
  form: { icon: FileText, tone: 'success' },
  import: { icon: FileSpreadsheet, tone: 'warning' },
  app: { icon: AppWindow, tone: 'primary' },
  system: { icon: Settings, tone: 'neutral' },
};

const EVENT_SENTENCE: Record<TableRecordEventView['type'], TranslationKey> = {
  created: 'tables.activity.created',
  updated: 'tables.activity.updated',
  deleted: 'tables.activity.deleted',
  restored: 'tables.activity.restored',
};

export function ActorKindBadge({ kind }: { kind: TableRecordActorKind }) {
  const t = useT();
  const { icon: Icon, tone } = ACTOR_KIND[kind] ?? ACTOR_KIND.system;
  return (
    <Tag tone={tone} icon={<Icon size={10} aria-hidden="true" />}>
      {t(`tables.activity.actorKind.${kind}` as TranslationKey)}
    </Tag>
  );
}

function useActorName(usersById: TableUsersById) {
  const t = useT();
  return (userId: string | null) =>
    (userId ? usersById.get(userId)?.nickname : undefined) ?? t('tables.activity.someone');
}

/** "via form #3", "by rule #12"… — where a non-personal write came from. */
function sourceNote(event: TableRecordEventView, t: ReturnType<typeof useT>): string | null {
  if (event.meta.formId) return t('tables.activity.viaForm', { id: event.meta.formId });
  if (event.meta.ruleId) return t('tables.activity.viaRule', { id: event.meta.ruleId });
  if (event.meta.appId) return t('tables.activity.viaApp', { id: event.meta.appId });
  if (event.meta.importId) return t('tables.activity.viaImport');
  return null;
}

function RowShell({ marker, children }: { marker: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="flex-shrink-0 pt-0.5">{marker}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

export function EventItem({
  event,
  fieldsById,
  usersById,
}: {
  event: TableRecordEventView;
  fieldsById: ReadonlyMap<number, TableField>;
  usersById: TableUsersById;
}) {
  const t = useT();
  const actorName = useActorName(usersById);
  const note = sourceNote(event, t);
  // The server already cut changes to what this reader may see; a field the
  // drawer does not know (hidden since) is simply not drawn.
  const changes = event.changes.filter((change) => fieldsById.has(change.fieldId));
  return (
    <RowShell
      marker={
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-muted text-fg-muted">
          <History size={13} aria-hidden="true" />
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-fg-secondary">
          {t(EVENT_SENTENCE[event.type], { actor: actorName(event.actorId) })}
        </span>
        <ActorKindBadge kind={event.actorKind} />
        {note && <span className="text-fg-muted">{note}</span>}
        <time className="text-fg-faint" dateTime={event.createdAt}>
          {formatDate(event.createdAt)}
        </time>
      </div>
      {changes.length > 0 && (
        <dl className="mt-2 space-y-1.5 rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-xs">
          {changes.map((change) => {
            const field = fieldsById.get(change.fieldId)!;
            return (
              <div key={change.fieldId} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-2">
                <dt className="truncate text-fg-muted" title={field.name}>
                  {field.name}
                </dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-1.5 break-words text-fg-secondary">
                  {event.type === 'updated' && (
                    <>
                      <span className="min-w-0 text-fg-faint">
                        <FieldValue field={field} value={change.before} usersById={usersById} />
                      </span>
                      <ArrowRight size={12} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
                    </>
                  )}
                  <span className="min-w-0">
                    <FieldValue field={field} value={change.after} usersById={usersById} />
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </RowShell>
  );
}

export function CommentItem({
  comment,
  usersById,
  canEdit,
  canDelete,
  editor,
  onEdit,
  onDelete,
}: {
  comment: TableRecordCommentView;
  usersById: TableUsersById;
  canEdit: boolean;
  canDelete: boolean;
  /** The edit composer, when this comment is being edited. */
  editor?: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const author = useActorName(usersById)(comment.authorId);
  return (
    <RowShell marker={<Avatar name={author} size="sm" />}>
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium text-fg" title={author}>
          {author}
        </span>
        <time className="flex-shrink-0 text-fg-faint" dateTime={comment.createdAt}>
          {formatDate(comment.createdAt)}
        </time>
        {comment.edited && <span className="flex-shrink-0 text-fg-faint">· {t('tables.activity.edited')}</span>}
        {!editor && (canEdit || canDelete) && (
          <span className="ml-auto flex flex-shrink-0 items-center">
            {canEdit && (
              <IconButton size="compact" label={t('tables.activity.editComment')} tooltip="top" onClick={onEdit}>
                <Pencil size={13} />
              </IconButton>
            )}
            {canDelete && (
              <IconButton
                size="compact"
                variant="destructive"
                label={t('tables.activity.deleteComment')}
                tooltip="top"
                onClick={onDelete}
              >
                <Trash2 size={13} />
              </IconButton>
            )}
          </span>
        )}
      </div>
      {editor ?? (
        <div className="mt-1 text-sm text-fg-secondary [&_a]:text-primary-fg [&_a]:no-underline">
          <Markdown content={comment.body} compact />
        </div>
      )}
    </RowShell>
  );
}
