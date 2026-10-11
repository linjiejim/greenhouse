import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ShareableUser, UserGroup } from '@greenhouse/types/api';
import { I18nProvider } from '../../lib/i18n';
import { PrincipalPicker } from './principal-picker';
import { matchesRecordsChanged } from '../../hooks/use-tables-records-changed';

const users: ShareableUser[] = [
  { id: 'u1', nickname: 'Jim', email: 'jim@example.com', role: 'team' },
  { id: 'u2', nickname: 'Mei', email: 'mei@example.com', role: 'team' },
];
const groups: UserGroup[] = [
  { id: 7, name: 'Finance', description: '', created_by: 'u2', member_count: 3, created_at: null, updated_at: null },
];

function render(element: React.ReactElement, locale: 'en' | 'zh' = 'en'): string {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}>{element}</I18nProvider>);
}

describe('PrincipalPicker', () => {
  it('shows who manages each group and offers everyone only when allowed', () => {
    const html = render(
      <PrincipalPicker
        value={{ userIds: ['u1'], groupIds: [7] }}
        onChange={() => undefined}
        users={users}
        groups={groups}
        allowEveryone
      />,
    );
    expect(html).toContain('Members managed by Mei');
    expect(html).toContain('Everyone in the workspace');
    expect(html).toContain('Remove Finance');
    expect(html).toContain('Remove Jim');
  });

  it('hides groups and excluded people when asked', () => {
    const html = render(
      <PrincipalPicker
        value={{ userIds: [], groupIds: [] }}
        onChange={() => undefined}
        users={users}
        groups={groups}
        allowGroups={false}
        excludeUserIds={['u2']}
      />,
      'zh',
    );
    expect(html).not.toContain('Finance');
    expect(html).not.toContain('mei@example.com');
    expect(html).toContain('jim@example.com');
    expect(html).not.toContain('工作区全员');
  });
});

describe('matchesRecordsChanged', () => {
  const event = { type: 'tables:records_changed' as const, baseId: 1, tableId: 2, recordIds: [5, 6] };
  it('filters by base, table and record', () => {
    expect(matchesRecordsChanged(event, { tableId: 2 })).toBe(true);
    expect(matchesRecordsChanged(event, { baseId: 9 })).toBe(false);
    expect(matchesRecordsChanged(event, { tableId: 2, recordIds: [6] })).toBe(true);
    expect(matchesRecordsChanged(event, { recordIds: [7] })).toBe(false);
  });
});
