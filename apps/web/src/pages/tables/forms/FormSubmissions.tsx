/** A form's submissions, newest first: the record each added (opens it in the base), who and when. */

import { ClipboardList } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Base, Form } from '@greenhouse/contract';
import { useSession } from '../../../app/session';
import { usePeople } from '../../../data/people';
import { useSubmissions } from '../../../data/tables-forms';
import { useI18n } from '../../../lib/i18n';
import { fullTime, relativeTime } from '../../../lib/time';
import { MemberAvatar } from '../../../shell/MemberAvatar';
import { formsError } from './errors';

export function FormSubmissions({
  base,
  form,
  onOpenRecord,
}: {
  base: Base;
  form: Form;
  onOpenRecord: (recordId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const { memberById } = usePeople();
  const list = useSubmissions(base.id, form.id);
  const timeZone = me?.timezone ?? 'Asia/Shanghai';
  if (list.isPending) return <Skeleton lines={4} />;
  if (list.isError) return <ErrorBox onRetry={() => void list.refetch()}>{formsError(list.error, t)}</ErrorBox>;
  const items = list.data.pages.flatMap((page) => page.items);
  if (!items.length) {
    return <Empty icon={<ClipboardList strokeWidth={icon.stroke} />} title={t('tables.forms.submissions.none')} />;
  }
  return (
    <ul className="app-list" aria-label={t('tables.forms.tab.submissions')}>
      {items.map((item) => {
        const name = item.member?.name || t('tables.activity.someone');
        return (
          <li key={item.id} className="app-list-row is-static">
            <MemberAvatar name={name} url={item.member ? memberById.get(item.member.id)?.avatar_url : null} size={28} />
            <span className="app-list-main">
              {item.record ? (
                <button
                  type="button"
                  className="app-link-button app-list-title app-tf-record-link"
                  onClick={() => onOpenRecord(item.record!.id)}
                >
                  {item.record.title || t('tables.record.untitled')}
                </button>
              ) : (
                <span className="app-list-title app-tf-gone">{t('tables.forms.submissions.gone')}</span>
              )}
              <span className="app-list-meta">{name}</span>
            </span>
            <time
              className="app-list-time"
              dateTime={item.created_at}
              title={fullTime(item.created_at, { locale, timeZone })}
            >
              {relativeTime(item.created_at, { locale, timeZone })}
            </time>
          </li>
        );
      })}
      {list.hasNextPage && (
        <li>
          <Button kind="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('common.more')}
          </Button>
        </li>
      )}
    </ul>
  );
}
