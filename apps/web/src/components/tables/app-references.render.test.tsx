/** @vitest-environment happy-dom */

/**
 * A 409 `used_by_apps` (apps spec D6) read into the shared contract and listed
 * with a link to each app's builder, each place worded in the reader's language
 * from the structured fields (the English `where` only when a server sends no
 * structure); any other failure is not one.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { TablesRequestError } from '../../lib/api/tables';
import type { AppReferencesConflict } from '@greenhouse/types/apps';
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

  it('keeps the structured place, dropping parts that are malformed', () => {
    const conflict = new TablesRequestError('used', 409, {
      reason: 'used_by_apps',
      references: [
        {
          appId: 4,
          name: 'Purchases',
          where: 'v2 › “Review” › “queue”',
          version: 2,
          page: { id: 'review', title: 'Review' },
          card: { id: 'queue', kind: 'records' },
          action: { id: 'approve' },
          role: 'nope',
        },
        { appId: 5, name: 'Old', where: 'draft › role “Reader”', version: -1 },
      ],
    });
    expect(appReferencesOf(conflict)?.references).toEqual([
      {
        appId: 4,
        name: 'Purchases',
        where: 'v2 › “Review” › “queue”',
        version: 2,
        page: { id: 'review', title: 'Review' },
        card: { id: 'queue', kind: 'records' },
      },
      { appId: 5, name: 'Old', where: 'draft › role “Reader”' },
    ]);
  });

  it('words each place in the reader’s language, naming an untitled card by its kind', async () => {
    const conflict: AppReferencesConflict = {
      reason: 'used_by_apps',
      references: [
        {
          appId: 4,
          name: '采购',
          where: 'draft › “审批” › “queue” › “通过”',
          version: 'draft',
          page: { id: 'review', title: '审批' },
          card: { id: 'queue', kind: 'kanban' },
          action: { id: 'approve', label: '通过' },
        },
        {
          appId: 4,
          name: '采购',
          where: 'v3 › “审批” › filter “部门”',
          version: 3,
          page: { id: 'review', title: '审批' },
          filter: { id: 'dept', label: '部门' },
        },
        { appId: 4, name: '采购', where: 'v3 › role “审批人”', version: 3, role: { key: 'approver', name: '审批人' } },
        { appId: 7, name: 'Old server', where: 'v1 › “Requests”' },
      ],
    };
    const render = async (locale: 'en' | 'zh') => {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(async () =>
        root.render(
          <I18nProvider initialLocale={locale}>
            <AppReferencesList conflict={conflict} />
          </I18nProvider>,
        ),
      );
      const rows = [...container.querySelectorAll('li')].map((row) => row.textContent);
      act(() => root.unmount());
      return rows;
    };
    expect(await render('zh')).toEqual([
      '采购 · 草稿 › 「审批」 › 看板卡片 › 按钮「通过」',
      '采购 · v3 › 「审批」 › 筛选器「部门」',
      '采购 · v3 › 角色「审批人」',
      'Old server · v1 › “Requests”',
    ]);
    expect(await render('en')).toEqual([
      '采购 · Draft › “审批” › Board card › button “通过”',
      '采购 · v3 › “审批” › filter “部门”',
      '采购 · v3 › role “审批人”',
      'Old server · v1 › “Requests”',
    ]);
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
