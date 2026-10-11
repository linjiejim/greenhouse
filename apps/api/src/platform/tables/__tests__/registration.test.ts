/**
 * The composed Tables registration against the manifest: every action has
 * exactly one handler and one audit resource, and domain errors map to the
 * right action failures (write-rights errors → FORBIDDEN, other validation
 * errors → INVALID_INPUT).
 */

import { describe, expect, it } from 'vitest';
import type { PlatformActionRequest } from '@greenhouse/platform-kernel';
import { TablesValidationError, type DatabaseProvider } from '@greenhouse/db';
import { tablesManifest } from '../../manifests/tables.js';
import type { PlatformHandlerContext } from '../../runtime.js';
import { TABLES_HANDLERS, tablesRegistration } from '../application.js';
import { TABLES_ACTION_RESOURCES, tablesResource } from '../audit.js';

const actionIds = Object.keys(tablesManifest.actions).sort();

function request(actionId: string, payload: unknown = {}): PlatformActionRequest {
  return {
    actor: { actorId: 'u-1', actorType: 'human', orgId: 'default', requestId: 'r-1', authMethod: 'bearer' },
    appId: 'tables',
    actionId,
    payload,
  };
}

describe('Tables registration (manifest 1.5.0)', () => {
  it('declares the action table of the foundation spec', () => {
    expect(tablesManifest.version).toBe('1.5.0');
    expect(Object.keys(tablesManifest.entities)).toEqual(expect.arrayContaining(['role', 'comment']));
    expect(tablesManifest.entities).not.toHaveProperty('notification');
    expect(tablesManifest.actions).not.toHaveProperty('listNotifications');
    expect(tablesManifest.actions).not.toHaveProperty('markNotificationRead');
    expect(tablesManifest.capabilities).toEqual(
      expect.arrayContaining(['tables.data.submitForm', 'tables.data.comment']),
    );
    expect(tablesManifest.capabilities).not.toContain('tables.data.notifications');
    expect(tablesManifest.actions.submitForm?.capability).toBe('tables.data.submitForm');
    expect(tablesManifest.actions.openForm).toMatchObject({ kind: 'query', capability: 'tables.data.submitForm' });
    expect(tablesManifest.actions.createComment).toMatchObject({
      entity: 'comment',
      capability: 'tables.data.comment',
    });
    expect(tablesManifest.actions.updateRole).toMatchObject({ entity: 'role', module: 'structure' });
  });

  it('declares the apps module of Phase 1 (apps spec §4)', () => {
    expect(tablesManifest.modules).toHaveProperty('apps');
    expect(tablesManifest.entities.app).toMatchObject({ module: 'apps', table: 'table_apps' });
    expect(tablesManifest.capabilities).toEqual(
      expect.arrayContaining(['tables.apps.use', 'tables.apps.manage', 'tables.apps.publish']),
    );
    const apps = Object.values(tablesManifest.actions).filter((action) => action.module === 'apps');
    // Phase 2 adds templates (`appTemplate`) to the module; everything else acts on an app.
    expect(apps.every((action) => action.entity === 'app' || action.entity === 'appTemplate')).toBe(true);
    // Granting access to people outside the Base is the owner's: publish, audiences and featuring need `publish`.
    for (const id of ['publishApp', 'setAppAudiences', 'featureApp']) {
      expect(tablesManifest.actions[id]?.capability).toBe('tables.apps.publish');
    }
    for (const id of ['createApp', 'saveAppDraft', 'restoreAppVersion', 'getAppDraft']) {
      expect(tablesManifest.actions[id]?.capability).toBe('tables.apps.manage');
    }
    for (const id of ['listApps', 'getApp', 'queryAppCard', 'runAppAction', 'getAppFile', 'setAppPins']) {
      expect(tablesManifest.actions[id]?.capability).toBe('tables.apps.use');
    }
  });

  it('has real gateway handlers (slice G): no placeholder answers, an app id is required first', async () => {
    const gateway = [
      'queryAppCard',
      'getAppRecord',
      'runAppAction',
      'listAppActivity',
      'createAppComment',
      'updateAppComment',
      'deleteAppComment',
      'listAppFieldOptions',
      'uploadAppFile',
      'getAppFile',
    ];
    for (const id of gateway) {
      expect(await tablesRegistration.handlers[id]!(request(id, {}), { db: {} as DatabaseProvider })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        message: 'appId is required',
      });
    }
    expect(
      await tablesRegistration.handlers.getAppUsage!(request('getAppUsage', {}), { db: {} as DatabaseProvider }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('declares the Phase 2 actions (advanced spec §8, F2)', () => {
    expect(tablesManifest.entities.appTemplate).toMatchObject({ module: 'apps', table: 'table_app_templates' });
    expect(tablesManifest.capabilities).toEqual(
      expect.arrayContaining([
        'tables.apps.review',
        'tables.apps.templates.use',
        'tables.apps.templates.publish',
        'tables.apps.templates.review',
      ]),
    );
    const expected: Record<string, { entity: string; kind: 'query' | 'command'; capability: string }> = {
      listAppCustomReviews: { entity: 'app', kind: 'query', capability: 'tables.apps.review' },
      reviewAppCustomCode: { entity: 'app', kind: 'command', capability: 'tables.apps.review' },
      listAppTemplates: { entity: 'appTemplate', kind: 'query', capability: 'tables.apps.templates.use' },
      getAppTemplate: { entity: 'appTemplate', kind: 'query', capability: 'tables.apps.templates.use' },
      publishAppTemplate: { entity: 'appTemplate', kind: 'command', capability: 'tables.apps.templates.publish' },
      reviewAppTemplate: { entity: 'appTemplate', kind: 'command', capability: 'tables.apps.templates.review' },
      installAppTemplate: { entity: 'appTemplate', kind: 'command', capability: 'tables.apps.templates.use' },
      archiveAppTemplate: { entity: 'appTemplate', kind: 'command', capability: 'tables.apps.templates.publish' },
      fillAiField: { entity: 'field', kind: 'command', capability: 'tables.structure.update' },
      regenerateAiField: { entity: 'field', kind: 'command', capability: 'tables.structure.update' },
      getAiFieldStatus: { entity: 'field', kind: 'query', capability: 'tables.structure.read' },
    };
    for (const [id, shape] of Object.entries(expected)) {
      expect(tablesManifest.actions[id], id).toMatchObject(shape);
    }
    // AI-field work is audited against the field (and so filed under its Base); templates belong to no Base.
    expect(tablesResource('fillAiField', { fieldId: 12 })).toMatchObject({ entityId: 'field', recordId: '12' });
    expect(tablesResource('reviewAppCustomCode', { appId: 7 })).toMatchObject({ entityId: 'app', recordId: '7' });
    expect(tablesResource('installAppTemplate', { appId: 7 }).recordId).toBeUndefined();
  });

  it('answers not_implemented from every Phase 2 placeholder until its slice lands', async () => {
    const placeholders = [
      'listAppCustomReviews',
      'reviewAppCustomCode',
      'listAppTemplates',
      'getAppTemplate',
      'publishAppTemplate',
      'reviewAppTemplate',
      'installAppTemplate',
      'archiveAppTemplate',
      'fillAiField',
      'regenerateAiField',
      'getAiFieldStatus',
    ];
    for (const id of placeholders) {
      expect(await tablesRegistration.handlers[id]!(request(id, {}), { db: {} as DatabaseProvider }), id).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        message: 'not_implemented',
        details: { notImplemented: true },
      });
    }
  });

  it('has exactly one handler and one audit resource per action', () => {
    expect(Object.keys(TABLES_HANDLERS).sort()).toEqual(actionIds);
    expect(Object.keys(tablesRegistration.handlers).sort()).toEqual(actionIds);
    expect(Object.keys(TABLES_ACTION_RESOURCES).sort()).toEqual(actionIds);
  });

  it('stamps the declared resource id into the audit event, ignoring the others', () => {
    expect(tablesResource('getRecord', { tableId: 4, recordId: 9 })).toMatchObject({
      appId: 'tables',
      entityId: 'record',
      recordId: '9',
    });
    expect(tablesResource('createRecord', { tableId: 4, recordId: 9 }).recordId).toBe('4');
    expect(tablesResource('updateComment', { recordId: 9, commentId: 12 }).recordId).toBe('12');
    expect(tablesResource('updateRole', { baseId: 1, roleId: 5 }).recordId).toBe('5');
    expect(tablesResource('listBases', { baseId: 1 }).recordId).toBeUndefined();
    expect(tablesResource('publishApp', { baseId: 1, appId: 7 })).toMatchObject({ entityId: 'app', recordId: '7' });
    expect(tablesResource('createApp', { baseId: 3 }).recordId).toBe('3');
    expect(tablesResource('listAppPins', { appId: 7 }).recordId).toBeUndefined();
  });

  it('maps write-rights errors to FORBIDDEN and other validation errors to INVALID_INPUT', async () => {
    const throwing = (error: Error): PlatformHandlerContext => ({
      db: {
        tables: {
          getTable: async () => {
            throw error;
          },
        },
      } as unknown as DatabaseProvider,
    });
    const handler = tablesRegistration.handlers.createRecord!;
    const payload = { tableId: 1, values: { 1: 'x' } };

    const forbidden = await handler(
      request('createRecord', payload),
      throwing(new TablesValidationError('Field 2 is not editable', 'field_not_editable')),
    );
    expect(forbidden).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Field 2 is not editable',
      details: { reason: 'field_not_editable' },
    });

    // An unreadable field must look exactly like a missing one: no reason code.
    const unreadable = await handler(
      request('createRecord', payload),
      throwing(new TablesValidationError('Field 2 is unavailable', 'field_not_readable')),
    );
    expect(unreadable).toEqual({ ok: false, code: 'INVALID_INPUT', message: 'Field 2 is unavailable' });
  });
});
