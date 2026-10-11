/**
 * Inbox rows open what their push would (./model.ts), from validated ids only.
 */

import { describe, expect, it } from 'vitest';

import { hrefRoute, inboxHref } from './model';

describe('inbox targets', () => {
  it('follows the push envelope first: Bots cards and replies, task results, Tables records', () => {
    expect(inboxHref({ payload: { push: { k: 'needs_you', open: 'bots', sid: 'dm-1', rid: 'brq_1' } } })).toBe(
      '/bots?c=dm-1&request=brq_1',
    );
    expect(inboxHref({ payload: { push: { k: 'replies', open: 'bots', sid: 'dm-1', rid: 'x' } } })).toBe(
      '/bots?c=dm-1',
    );
    expect(inboxHref({ payload: { push: { k: 'done', open: 'chat', sid: 'session-9' } } })).toBe('/chat/session-9');
    expect(
      inboxHref({ payload: { push: { k: 'done', open: 'record', base_id: 7, table_id: 8, record_id: 42 } } }),
    ).toBe('/tables/record/42?tableId=8&baseId=7');
    expect(inboxHref({ payload: { push: { k: 'replies', open: 'app', app_id: 9, table_id: 8, record_id: 42 } } })).toBe(
      '/apps/9?record=42&table=8',
    );
  });

  it('reads a Tables href when there is no envelope', () => {
    expect(inboxHref({ payload: { href: '#/tables/7/table/8?record=42' } })).toBe(
      '/tables/record/42?tableId=8&baseId=7',
    );
    expect(inboxHref({ payload: { href: '#/tables/7/table/8' } })).toBe('/tables/table/8?baseId=7');
    expect(inboxHref({ payload: { href: '#/apps/9?record=42' } })).toBe('/apps/9?record=42');
    expect(hrefRoute('#/apps/9/approve')).toEqual({
      kind: 'app',
      appId: 9,
      pageId: 'approve',
      recordId: null,
      tableId: null,
    });
  });

  it('opens nothing for what the phone has no page for, or for malformed ids', () => {
    expect(inboxHref({ payload: { href: '#/settings' } })).toBeNull();
    expect(inboxHref({ payload: { href: 'https://evil.example/#/tables/1/table/2' } })).toBeNull();
    expect(inboxHref({ payload: { href: '#/tables/0/table/2?record=1' } })).toBeNull();
    expect(inboxHref({ payload: { push: { k: 'done', open: 'chat', sid: '../x y' } } })).toBeNull();
    expect(inboxHref({ payload: null })).toBeNull();
    expect(inboxHref({ payload: 'text' })).toBeNull();
  });
});
