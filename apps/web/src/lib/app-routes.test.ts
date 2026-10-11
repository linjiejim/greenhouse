import { describe, expect, it } from 'vitest';
import { APP_BUILDER_SEGMENT, appBuilderHref, appHref, appRecordHref, parseAppRoute } from './app-routes';

describe('app routes', () => {
  it('parses the center, a runtime page and the builder', () => {
    expect(parseAppRoute('')).toEqual({ kind: 'center' });
    expect(parseAppRoute('12')).toEqual({ kind: 'runtime', appId: 12 });
    expect(parseAppRoute('12/approvals')).toEqual({ kind: 'runtime', appId: 12, pageId: 'approvals' });
    expect(parseAppRoute(`12/${APP_BUILDER_SEGMENT}`)).toEqual({ kind: 'builder', appId: 12 });
  });

  it('rejects ids that are not positive integers and paths deeper than a page', () => {
    for (const subPath of ['0', '-3', 'abc', '1.5', '12/page/extra']) {
      expect(parseAppRoute(subPath), subPath).toEqual({ kind: 'invalid' });
    }
  });

  it('round-trips a page id through its href, escapes included', () => {
    expect(appHref(7)).toBe('#/apps/7');
    expect(appHref(7, 'my page')).toBe('#/apps/7/my%20page');
    expect(parseAppRoute(appHref(7, 'my page').replace('#/apps/', ''))).toEqual({
      kind: 'runtime',
      appId: 7,
      pageId: 'my page',
    });
    expect(parseAppRoute('7/%E0%A4%A')).toEqual({ kind: 'runtime', appId: 7, pageId: '%E0%A4%A' });
  });

  it('builds the builder and record links', () => {
    expect(appBuilderHref(3)).toBe('#/apps/3/edit');
    expect(appRecordHref(3, 41)).toBe('#/apps/3?record=41');
    expect(appRecordHref(3, 41, 'orders')).toBe('#/apps/3/orders?record=41');
  });
});
