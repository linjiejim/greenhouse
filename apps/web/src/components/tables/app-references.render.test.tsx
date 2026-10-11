/** @vitest-environment happy-dom */

/**
 * A 409 `used_by_apps` (apps spec D6) read into the shared contract and listed
 * with a link to each app's builder; any other failure is not one.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { TablesRequestError } from '../../lib/api/tables';
import { appReferencesOf, AppReferencesList } from './app-references';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('app references', () => {
  it('reads only a 409 used_by_apps, dropping malformed entries', () => {
    const conflict = new TablesRequestError('used', 409, {
      reason: 'used_by_apps',
      references: [{ appId: 4, name: 'Purchases', where: 'Approve › Queue › Approve' }, { appId: 'x' }, null],
    });
    expect(appReferencesOf(conflict)).toEqual({
      reason: 'used_by_apps',
      references: [{ appId: 4, name: 'Purchases', where: 'Approve › Queue › Approve' }],
    });
    expect(appReferencesOf(new TablesRequestError('stale', 409, { reason: 'conflict' }))).toBeNull();
    expect(appReferencesOf(new Error('nope'))).toBeNull();
  });

  it('lists each app with a link to its builder', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <AppReferencesList
            conflict={{ reason: 'used_by_apps', references: [{ appId: 4, name: 'Purchases', where: 'Approve' }] }}
          />
        </I18nProvider>,
      ),
    );
    expect(container.textContent).toContain('Apps use this:');
    expect(container.querySelector('a[href="#/apps/4/edit"]')?.textContent).toBe('Purchases');
    act(() => root.unmount());
  });
});
