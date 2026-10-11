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

describe('Tables registration (manifest 1.4.0)', () => {
  it('declares the action table of the foundation spec', () => {
    expect(tablesManifest.version).toBe('1.4.0');
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
    expect(apps.every((action) => action.entity === 'app')).toBe(true);
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

  it('answers not_implemented on the gateway actions until slice G', async () => {
    for (const id of ['queryAppCard', 'getAppRecord', 'runAppAction', 'getAppFile', 'getAppUsage']) {
      expect(await tablesRegistration.handlers[id]!(request(id, { appId: 1 }), { db: {} as DatabaseProvider })).toEqual(
        {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'not_implemented',
          details: { notImplemented: true },
        },
      );
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
