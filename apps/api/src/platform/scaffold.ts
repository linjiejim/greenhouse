/**
 * Small, deterministic scaffold for a new Platform application.
 *
 * It intentionally generates only the contract boundary. Domain tables,
 * services, adapters, and UI remain explicit because their security and data
 * semantics cannot be generated safely.
 */

import { isStableId } from '@greenhouse/platform-kernel';

export interface PlatformAppScaffoldFile {
  path: string;
  content: string;
}

export interface PlatformAppScaffold {
  appId: string;
  title: string;
  files: PlatformAppScaffoldFile[];
  nextSteps: string[];
}

function tableNameFor(appId: string): string {
  const snake = appId.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const tableName = `${snake}_records`;
  if (tableName.length > 63) {
    throw new Error(`Application ID "${appId}" is too long to derive a PostgreSQL table name`);
  }
  return tableName;
}

function manifestTemplate(appId: string, title: string, tableName: string): string {
  const commentTitle = title.replace(/\*\//g, '* /');
  return `/**
 * ${commentTitle} Platform Manifest.
 *
 * Keep this file JSON-serializable. Runtime dependencies belong in
 * registration.ts and domain adapters.
 */

import { compileApp, defineApp } from '@greenhouse/platform-kernel';

export const ${appId}Manifest = compileApp(
  defineApp({
    id: '${appId}',
    version: '0.1.0',
    title: ${JSON.stringify(title)},
    description: 'TODO: describe the application boundary and intended users.',
    modules: {
      main: {
        title: 'Main',
        description: 'TODO: describe this module.',
        icon: 'LayoutGrid',
      },
    },
    entities: {
      record: {
        title: 'Record',
        module: 'main',
        table: '${tableName}',
        accessScopes: ['own', 'all'],
        fields: {
          id: { kind: 'integer', title: 'ID', classification: 'internal' },
          title: {
            kind: 'text',
            title: 'Title',
            required: true,
            searchable: true,
            sortable: true,
          },
          ownerId: {
            kind: 'user',
            title: 'Owner',
            required: true,
            filterable: true,
          },
          createdAt: {
            kind: 'dateTime',
            title: 'Created at',
            sortable: true,
            classification: 'internal',
          },
        },
      },
    },
    actions: {
      listRecords: {
        title: 'List records',
        module: 'main',
        entity: 'record',
        kind: 'query',
        capability: '${appId}.main.read',
        risk: 'read',
        mcp: true,
      },
      createRecord: {
        title: 'Create record',
        module: 'main',
        entity: 'record',
        kind: 'command',
        capability: '${appId}.main.create',
        risk: 'medium',
        mcp: true,
      },
    },
    navigation: [
      {
        id: '${appId}',
        title: ${JSON.stringify(title)},
        module: 'main',
        path: '/${appId}',
        capability: '${appId}.main.read',
      },
    ],
  }),
);
`;
}

function registrationTemplate(appId: string, title: string): string {
  const commentTitle = title.replace(/\*\//g, '* /');
  return `/**
 * ${commentTitle} Platform registration.
 *
 * Replace the fail-closed placeholder with calls into the domain service.
 */

import type {
  ApplicationRegistration,
  PlatformActionHandler,
} from '@greenhouse/platform-kernel';
import { ${appId}Manifest } from './manifest.js';

export interface ${appId[0]!.toUpperCase()}${appId.slice(1)}Context {
  // TODO: inject only the domain dependencies required by the handlers.
}

const notImplemented: PlatformActionHandler<${appId[0]!.toUpperCase()}${appId.slice(1)}Context> = async () => ({
  ok: false,
  code: 'INTERNAL_ERROR',
  message: ${JSON.stringify(`${title} handler is not implemented`)},
});

const handlers = Object.fromEntries(
  Object.keys(${appId}Manifest.actions).map((actionId) => [
    actionId,
    notImplemented,
  ]),
) as Record<
  string,
  PlatformActionHandler<${appId[0]!.toUpperCase()}${appId.slice(1)}Context>
>;

export const ${appId}Registration: ApplicationRegistration<${appId[0]!.toUpperCase()}${appId.slice(1)}Context> = {
  manifest: ${appId}Manifest,
  handlers,
};
`;
}

function testTemplate(appId: string, title: string): string {
  return `import { describe, expect, it } from 'vitest';
import { ApplicationRegistry } from '@greenhouse/platform-kernel';
import { ${appId}Registration } from './registration.js';

describe(${JSON.stringify(`${title} Platform application`)}, () => {
  it('registers a complete, deterministic manifest', () => {
    const registry = new ApplicationRegistry({
      authorize: () => ({ allowed: true, reason: 'test' }),
      audit: () => undefined,
    });
    expect(() => registry.register(${appId}Registration)).not.toThrow();
    expect(registry.getManifest('${appId}')).toMatchObject({
      id: '${appId}',
      version: '0.1.0',
      capabilities: ['${appId}.main.create', '${appId}.main.read'],
    });
  });
});
`;
}

function readmeTemplate(appId: string, title: string): string {
  return `# ${title}

Generated Platform application boundary for \`${appId}\`.

Before enabling traffic:

1. Add the domain schema/service and a reviewed migration if persistence is required.
2. Replace the fail-closed handlers in \`registration.ts\`.
3. Add record-scope SQL, record IDOR, field read/write/export, and related-record checks.
4. Add the Manifest to \`platform/bootstrap.ts\` with an explicit baseline (never \`${appId}.*\` by accident).
5. Add the Registration to runtime initialization in \`apps/api/src/index.ts\`.
6. Add thin HTTP/Tool/MCP adapters only for declared actions.
7. Add parity/security tests for default-deny, scope, IDOR, fields, destructive actions, audit, and feature rollout.
8. If the app has a dedicated Web UI, register its host route in \`apps/web/src/platform/catalog.ts\`; otherwise it remains Agent/MCP-only.

Do not put database clients, Hono handlers, React components, functions, secrets, or runtime timestamps in the Manifest.
`;
}

export function buildPlatformAppScaffold(input: { appId: string; title?: string }): PlatformAppScaffold {
  const appId = input.appId.trim();
  if (!isStableId(appId)) {
    throw new Error('Application ID must be a stable lowerCamelCase ID (1-64 characters)');
  }
  const title = (input.title || appId).replace(/\s+/g, ' ').trim();
  if (!title || title.length > 120) {
    throw new Error('Application title must contain 1-120 characters');
  }
  const tableName = tableNameFor(appId);
  return {
    appId,
    title,
    files: [
      {
        path: 'manifest.ts',
        content: manifestTemplate(appId, title, tableName),
      },
      {
        path: 'registration.ts',
        content: registrationTemplate(appId, title),
      },
      {
        path: 'application.test.ts',
        content: testTemplate(appId, title),
      },
      { path: 'README.md', content: readmeTemplate(appId, title) },
    ],
    nextSteps: [
      'Implement the domain service and guarded handlers',
      'Register the Manifest in platform/bootstrap.ts',
      'Register the application in apps/api/src/index.ts',
      'Add transport parity and security tests',
    ],
  };
}
