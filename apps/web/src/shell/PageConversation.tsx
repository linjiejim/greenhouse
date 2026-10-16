import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button, ErrorBox, Overlay, Skeleton, Spinner } from '@greenhouse/ui/kit';
import type { PageContext } from '@greenhouse/contract';
import { useCreateConversation } from '../data/conversations';
import { useT } from '../lib/i18n';
import { navigate, type Route } from '../lib/router';
const ConversationPage = lazy(() =>
  import('../pages/conversation/ConversationPage').then((module) => ({ default: module.ConversationPage })),
);

export function contextOf(route: Route): PageContext {
  if (route.page === 'doc' || route.page === 'run' || route.page === 'agent') return { kind: route.page, id: route.id };
  if (route.page === 'base' && route.record) return { kind: 'record', id: route.record };
  if (route.page === 'app') return { kind: 'app', id: route.id, page_id: route.appPage };
  return { kind: 'page', name: route.page };
}

export function PageConversation({
  route,
  chatId,
  onCreated,
  onClose,
}: {
  route: Route;
  chatId?: string;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const create = useCreateConversation();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const { mutateAsync } = create;
  useEffect(() => {
    if (chatId || started.current) return;
    started.current = true;
    void mutateAsync({ kind: 'chat', title: t('pageConversation.title'), context: contextOf(route) })
      .then((chat) => onCreated(chat.id))
      .catch(() => setFailed(true));
  }, [chatId, mutateAsync, onCreated, route, t]);
  return (
    <Overlay title={t('pageConversation.title')} onClose={onClose} wide>
      <div className="app-page-conversation">
        {chatId ? (
          <>
            <Button
              size="sm"
              onClick={() => {
                onClose();
                navigate({ page: 'conversation', id: chatId });
              }}
            >
              {t('pageConversation.open')}
            </Button>
            <Suspense
              fallback={
                <div role="status" aria-label={t('common.loading')}>
                  <Skeleton lines={8} />
                </div>
              }
            >
              <ConversationPage id={chatId} />
            </Suspense>
          </>
        ) : failed ? (
          <ErrorBox
            onRetry={() => {
              started.current = true;
              setFailed(false);
              void mutateAsync({ kind: 'chat', context: contextOf(route) })
                .then((chat) => onCreated(chat.id))
                .catch(() => setFailed(true));
            }}
          >
            {t('common.error')}
          </ErrorBox>
        ) : (
          <Spinner />
        )}
      </div>
    </Overlay>
  );
}
