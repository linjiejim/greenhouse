import { describe, expect, it } from 'vitest';
import { mapLegacyLink } from './legacy-links';
/** Inventory: scheduler/notify, feishu/bot/dispatch, entity-links, object-refs,
 * security/account, skills/notify, OAuth returns, activity and PushData. */
describe('classic links from station messages', () => {
  it.each([
    ['/#/chat/abc', '/chat?session=abc'],
    ['#/chat?session=abc', '/chat?session=abc'],
    ['#/chat', '/'],
    ['#/kb', '/knowledge'],
    ['#/knowledge/folder/12', '/knowledge?shelf=team&folder=12'],
    ['#/knowledge/personal', '/knowledge?shelf=personal'],
    ['#/knowledge/shared', '/knowledge?shelf=shared'],
    ['#/kb/doc/123-policy', '/sheet/doc?id=123'],
    ['#/knowledge/doc/123-policy', '/sheet/doc?id=123'],
    ['#/knowledge/doc/runbook', '/sheet/doc?slug=runbook'],
    ['#/knowledge/internal/hr/time-off', '/sheet/doc?slug=time-off'],
    ['#/knowledge/personal/notes/edit', '/sheet/doc?slug=notes'],
    ['#/knowledge/shared/notes', '/sheet/doc?slug=notes'],
    ['#/knowledge/folder/12/notes', '/sheet/doc?slug=notes'],
    ['#/files?file=12', '/sheet/file?id=12'],
    ['#/files?folder=12&shelf=personal', '/sheet/folder?id=12&shelf=personal&scope=drive'],
    ['#/projects/3?task=4', '/sheet/task?project=3&id=4'],
    ['#/projects/3', '/sheet/project?id=3'],
    ['#/projects', '/projects'],
    ['#/tables/1/table/2?record=3', '/sheet/record?base=1&table=2&id=3'],
    ['#/tables/1/table/2', '/drive/table?id=2'],
    ['#/tables/1', '/drive/base?id=1'],
    ['#/tables', '/drive?view=tables'],
    ['#/activity/automation/run_01', '/sheet/run?id=run_01'],
    ['#/activity/run_01', '/sheet/run?id=run_01'],
    ['#/tasks', '/automations'],
    ['#/automations', '/automations'],
    ['#/notifications?id=n_01', '/sheet/notification?id=n_01'],
    ['#/settings', '/me'],
    ['#/settings/notifications', '/me/notifications'],
    ['#/settings/agent-connections/activity', '/me/agents'],
    ['#/settings/provider-bindings?feishu=ok', '/bindings?feishu=ok'],
    ['#/settings/provider-bindings?wecom=error&reason=already_bound', '/bindings?wecom=error&reason=already_bound'],
    ['#/settings/provider-bindings', '/me/connectors'],
    ['#/connectors/oauth-finish?code=x&state=s', '/connectors/oauth-finish#code=x&state=s'],
    ['#/activate?token=x', '/activate#token=x'],
    ['#/activate', '/activate'],
    ['#/login', '/login'],
    ['#/login?feishu_code=c', '/login#feishu_code=c'],
    ['#/login?feishu=error&reason=not_bound', '/login#feishu=error&reason=not_bound'],
    ['#/skillhub', '/p/skills/skills'],
    ['#/skillhub/example', '/p/skills/skills'],
    ['#/skillhub?tab=reports', '/p/reports/reports'],
    ['#/ext/crm/company', '/p/crm/crm-company'],
    ['#/ext/crm/company/42', '/p/crm/crm-company'],
    // no client page and no classic fallback: home
    ['#/example/notes/42', '/'],
    ['#/administration', '/'],
  ])('%s → %s', (input, output) => expect(mapLegacyLink(input)).toBe(output));
  it('never sends a link to the classic app', () => {
    for (const hash of ['#/whatever', '#/settings/unknown', '#/chat/%E0%A4%A'])
      expect(mapLegacyLink(hash)?.startsWith('/classic')).toBe(false);
  });
  it('does not hijack ordinary fragment anchors', () => expect(mapLegacyLink('#section')).toBeNull());
});
