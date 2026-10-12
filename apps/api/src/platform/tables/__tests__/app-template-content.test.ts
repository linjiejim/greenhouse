import { describe, expect, it } from 'vitest';
import { checkTemplateContent, sanitizeTemplateOperations, type TemplateContent } from '../app-templates/content.js';
import { appTemplates } from '../app-templates/index.js';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';

describe('template content', () => {
  it('validates and scans all four repository templates', () => {
    expect([...appTemplates().keys()]).toEqual(['procurement', 'it-tickets', 'crm', 'recruiting']);
    for (const template of appTemplates().values()) {
      const checked = checkTemplateContent(template);
      expect(checked.customCards).toBe(0);
      expect(checked.scan.status).toBe('clean');
    }
  });
  it('disables automations and strips webhooks and fixed recipients without mutating source', () => {
    const operations: SchemaPlanOperation[] = [
      {
        op: 'automation.create',
        ref: 'rule',
        tableRef: 'rows',
        name: 'Rule',
        trigger: 'record_created',
        status: 'enabled',
        config: {
          actions: [
            { id: 'hook', type: 'webhook', url: 'https://example.com' },
            {
              id: 'mail',
              type: 'notify',
              recipients: { userIds: ['publisher'], groupIds: [1], creator: true, userFieldIds: ['$field:owner'] },
              title: 'Created',
              message: 'Message',
            },
          ],
        },
      },
    ];
    const result = sanitizeTemplateOperations(operations);
    expect(result[0]).toMatchObject({
      status: 'disabled',
      config: { actions: [{ id: 'mail', recipients: { creator: true, userFieldIds: ['$field:owner'] } }] },
    });
    expect(JSON.stringify(result)).not.toMatch(/example.com|publisher|groupIds/);
    expect(operations[0]?.op === 'automation.create' && operations[0].status).toBe('enabled');
  });
  it('rejects update/share/publish plans and payloads that target existing Bases', () => {
    const template = appTemplates().get('crm')!;
    const content = structuredClone(template) as TemplateContent;
    content.plans.en.operations.push({ op: 'app.publish', appId: 123, notes: 'Test publish' });
    expect(() => checkTemplateContent(content)).toThrow(/permitted/);
  });
});
