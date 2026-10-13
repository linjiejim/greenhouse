import { RefreshCw } from 'lucide-react';
import { Button, ErrorBox, KitProvider, Spinner } from '@greenhouse/ui/kit';
import { useI18n } from '../lib/i18n';
import { useRoute } from '../lib/router';
import { ActivatePage } from '../pages/ActivatePage';
import { ConsentPage } from '../pages/ConsentPage';
import { LoginPage } from '../pages/LoginPage';
import { Shell } from '../shell/Shell';
import { NotifyProvider } from './notify';
import { useSession } from './session';

/**
 * Sign-in, activation, the OAuth consent page, or the app; a banner when the server speaks a
 * newer API. Consent needs a member: signed out, sign-in shows first and the same address follows.
 */
export function App() {
  const { locale, t } = useI18n();
  const route = useRoute();
  const { signedIn, me, meError, retryMe, outdated } = useSession();
  let body;
  if (route.page === 'activate') body = <ActivatePage token={route.token} />;
  else if (route.page === 'consent' && route.error) body = <ConsentPage request="" error={route.error} />;
  else if (!signedIn) body = <LoginPage />;
  else if (me) body = route.page === 'consent' ? <ConsentPage request={route.request} error="" /> : <Shell />;
  else if (meError)
    body = (
      <div className="app-center">
        <ErrorBox onRetry={retryMe}>{t('login.offline')}</ErrorBox>
      </div>
    );
  else
    body = (
      <div className="app-center" role="status" aria-label={t('common.loading')}>
        <Spinner />
      </div>
    );
  return (
    <KitProvider locale={locale}>
      <NotifyProvider>
        {outdated && (
          <div className="app-update-banner" role="status">
            <span>{t('common.updateRequired')}</span>
            <Button size="sm" onClick={() => location.reload()}>
              <RefreshCw size={14} />
              {t('common.refresh')}
            </Button>
          </div>
        )}
        {body}
      </NotifyProvider>
    </KitProvider>
  );
}
