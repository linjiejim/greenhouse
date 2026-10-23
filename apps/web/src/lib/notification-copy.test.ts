import { describe, expect, it } from 'vitest';
import type { PlatformNotification } from '@greenhouse/types/notification';
import { translate, type AnyTranslationKey } from './i18n';
import { notificationCopy } from './notification-copy';

const zh = (key: AnyTranslationKey, params?: Record<string, string | number>) => translate('zh', key, params);
const en = (key: AnyTranslationKey, params?: Record<string, string | number>) => translate('en', key, params);

function item(over: Partial<PlatformNotification>): Pick<PlatformNotification, 'kind' | 'title' | 'body' | 'payload'> {
  return {
    kind: 'runtime_failed',
    title: 'Agent write needs review',
    body: 'Open Execution Center to review agent write awr_123.',
    payload: { runtime_kind: 'agent_write', status: 'failed' },
    ...over,
  };
}

describe('notificationCopy', () => {
  it('rewrites a pre-1.5 "Execution Center" line to the Activity log, in the reader’s language', () => {
    expect(notificationCopy(en, item({}))).toEqual({
      title: 'Agent write needs review',
      body: 'Open it in the Activity log to review what happened.',
    });
    const copy = notificationCopy(zh, item({}));
    expect(copy.title).toBe('Agent 写入需要查看');
    expect(copy.body).toContain('操作记录');
  });

  it('keeps an error the run reported, and anything that is not a Runtime notice', () => {
    expect(notificationCopy(en, item({ body: 'Document not found: q4' })).body).toBe('Document not found: q4');
    const automation = item({ kind: 'system', title: '✅ Daily digest', body: '**Done**', payload: {} });
    expect(notificationCopy(zh, automation)).toEqual({ title: '✅ Daily digest', body: '**Done**' });
  });

  it('titles an interrupt by what it is waiting for', () => {
    const copy = notificationCopy(
      en,
      item({
        kind: 'runtime_attention',
        payload: { runtime_kind: 'automation', interrupt_kind: 'credential_required' },
        body: 'Open it in the Activity log to review this automation.',
      }),
    );
    expect(copy).toEqual({
      title: 'Automation needs credentials',
      body: 'Open it in the Activity log to review what happened.',
    });
  });
});
