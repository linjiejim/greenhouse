import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const branding = vi.hoisted(() => ({ setupPending: false }));

vi.mock('../../lib/workspace-branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workspace-branding')>()),
  isWorkspaceSetupPending: () => branding.setupPending,
}));

const { LoginScreen } = await import('./login-screen');
const { I18nProvider } = await import('../../lib/i18n');

function render(locale: 'en' | 'zh' = 'en') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LoginScreen onSuccess={vi.fn()} />
    </I18nProvider>,
  );
}

describe('LoginScreen first-run notice', () => {
  it('stays out of the way on an instance someone already owns', () => {
    branding.setupPending = false;
    expect(render()).not.toContain('data-testid="login-setup-pending"');
  });

  it('says where the first administrator activation link is while setup is pending', () => {
    branding.setupPending = true;
    const html = render();
    expect(html).toContain('data-testid="login-setup-pending"');
    expect(html).toContain('Finish setting up this workspace');
    expect(html).toContain('BOOTSTRAP_ADMIN_EMAIL');

    expect(render('zh')).toContain('先完成这个工作区的初始化');
  });
});
