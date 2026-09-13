import { describe, expect, it, vi } from 'vitest';

import { AuthorizationDeniedError } from '../authz.js';
import type { ActorContext, PlatformAuditEvent } from '../contract.js';
import { compileApp, type ApplicationDefinition } from '../dsl.js';
import {
  ApplicationRegistrationError,
  ApplicationRegistry,
  type PlatformActionHandler,
  type RuntimeAuthorizationDecision,
} from '../registry.js';

const actor: ActorContext = {
  actorId: 'user-1',
  actorType: 'human',
  orgId: 'default',
  requestId: 'request-1',
  authMethod: 'session',
};

function manifest() {
  const definition: ApplicationDefinition = {
    id: 'projects',
    version: '1.0.0',
    title: 'Projects',
    modules: { project: { title: 'Projects' } },
    entities: {
      project: {
        title: 'Project',
        module: 'project',
        table: 'projects',
        accessScopes: ['own', 'all'],
        fields: { title: { kind: 'text', title: 'Title' } },
      },
    },
    actions: {
      listProjects: {
        title: 'List projects',
        module: 'project',
        entity: 'project',
        kind: 'query',
        capability: 'projects.project.read',
        risk: 'read',
      },
      deleteProject: {
        title: 'Delete project',
        module: 'project',
        entity: 'project',
        kind: 'command',
        capability: 'projects.project.delete',
        risk: 'destructive',
      },
    },
  };
  return compileApp(definition);
}

describe('ApplicationRegistry', () => {
  it('rejects incomplete or undeclared handler maps', () => {
    const registry = new ApplicationRegistry({
      authorize: () => ({ allowed: true, reason: 'test' }),
      audit: () => {},
    });

    expect(() =>
      registry.register({
        manifest: manifest(),
        handlers: {
          listProjects: async () => ({ ok: true, data: [] }),
          unknown: async () => ({ ok: true, data: null }),
        },
      }),
    ).toThrow(ApplicationRegistrationError);
  });

  it('authorizes, dispatches, and audits a successful action', async () => {
    const audits: PlatformAuditEvent[] = [];
    const registry = new ApplicationRegistry<{ tenant: string }>({
      authorize: (_actor, action): RuntimeAuthorizationDecision => ({
        allowed: action.capability.endsWith('.read'),
        reason: 'test-policy',
      }),
      audit: (event) => {
        audits.push(event);
      },
    });
    const list = vi.fn(async (_request, context: { tenant: string }) => ({
      ok: true as const,
      data: [context.tenant],
    }));
    registry.register({
      manifest: manifest(),
      handlers: {
        listProjects: list,
        deleteProject: async () => ({ ok: true, data: null }),
      },
    });

    const result = await registry.dispatch(
      { actor, appId: 'projects', actionId: 'listProjects', payload: {} },
      { tenant: 'default' },
    );

    expect(result).toEqual({ ok: true, data: ['default'] });
    expect(list).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actionId: 'listProjects',
      capability: 'projects.project.read',
      result: 'success',
      resource: { appId: 'projects', moduleId: 'project', entityId: 'project' },
    });
  });

  it('fails closed and audits denied actions before invoking a handler', async () => {
    const audits: PlatformAuditEvent[] = [];
    const deleteHandler = vi.fn(async () => ({ ok: true as const, data: null }));
    const registry = new ApplicationRegistry({
      authorize: (_actor, action) => ({
        allowed: action.capability.endsWith('.read'),
        reason: 'default-deny',
      }),
      audit: (event) => {
        audits.push(event);
      },
    });
    registry.register({
      manifest: manifest(),
      handlers: {
        listProjects: async () => ({ ok: true, data: [] }),
        deleteProject: deleteHandler,
      },
    });

    await expect(
      registry.dispatch({ actor, appId: 'projects', actionId: 'deleteProject', payload: { id: 1 } }, undefined),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(deleteHandler).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ result: 'denied', summary: { reason: 'default-deny' } });
  });

  it('lists only applications with at least one allowed action', async () => {
    const registry = new ApplicationRegistry({
      authorize: (_actor, action) => ({
        allowed: action.capability === 'projects.project.read',
        reason: 'test',
      }),
      audit: () => {},
    });
    registry.register({
      manifest: manifest(),
      handlers: {
        listProjects: async () => ({ ok: true, data: [] }),
        deleteProject: async () => ({ ok: true, data: null }),
      },
    });

    expect((await registry.listVisibleManifests(actor)).map((item) => item.id)).toEqual(['projects']);
  });

  it('does not invoke a handler twice when the audit sink fails', async () => {
    const handler = vi.fn(async () => ({ ok: true as const, data: null }));
    const audit = vi.fn(async () => {
      throw new Error('audit unavailable');
    });
    const registry = new ApplicationRegistry({
      authorize: () => ({ allowed: true, reason: 'test' }),
      audit,
    });
    registry.register({
      manifest: manifest(),
      handlers: {
        listProjects: handler,
        deleteProject: async () => ({ ok: true, data: null }),
      },
    });

    await expect(
      registry.dispatch({ actor, appId: 'projects', actionId: 'listProjects', payload: {} }, undefined),
    ).rejects.toThrow('audit unavailable');
    expect(handler).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });

  it('normalizes and freezes registrations so callers cannot mutate live authorization metadata', () => {
    const sourceManifest = manifest();
    const sourceHandlers: Record<string, PlatformActionHandler> = {
      listProjects: async () => ({ ok: true as const, data: [] }),
      deleteProject: async () => ({ ok: true as const, data: null }),
    };
    const registry = new ApplicationRegistry({
      authorize: () => ({ allowed: true, reason: 'test' }),
      audit: () => {},
    });
    registry.register({ manifest: sourceManifest, handlers: sourceHandlers });

    sourceManifest.actions.listProjects.capability = 'projects.project.delete';
    sourceHandlers.listProjects = async () => ({ ok: true, data: ['mutated'] });

    const registered = registry.getManifest('projects');
    expect(registered?.actions.listProjects.capability).toBe('projects.project.read');
    expect(() => {
      if (registered) registered.actions.listProjects.capability = 'projects.project.delete';
    }).toThrow(TypeError);
  });
});
