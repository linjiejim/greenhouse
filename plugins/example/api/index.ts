import manifest from '../manifest.js';
/**
 * The example extension — a complete, minimal reference for every field of the
 * contract: a table with its own migration, a service, a lazy tool, routes with a
 * feature guard, a feature flag + point, a runtime setting, a job and a command.
 *
 * It is compiled into every build but off by default; enable it per deployment
 * with `extensions.enabled: ['example']` in greenhouse.config.ts or
 * `GREENHOUSE_EXTENSIONS=example`. Copy this folder to start your own.
 */
import {
  defineExtension,
  defineApp,
  extensionPath,
  getDb,
  getExtensionServices,
  logger,
  notify,
  requireFeature,
} from '@greenhouse/api/extension-kit';
import { exampleRoutes } from './routes.js';
import { createExampleServices, noteAction, type ExampleServices } from './service.js';
import { exampleNotesMutationTool, exampleNotesQueryTool } from './tool.js';
import { z } from 'zod';

const definition = defineExtension({
  ...manifest,
  notificationKinds: ['ext:example:welcome'],
  dataSources: [
    {
      app: defineApp({
        id: 'example',
        title: 'Example notes',
        version: '1.0.0',
        modules: { note: { title: 'Notes' } },
        actions: {},
        entities: {
          note: {
            title: 'Note',
            module: 'note',
            table: 'ext_example_notes',
            accessScopes: ['own'],
            fields: {
              id: { kind: 'integer', title: 'ID', sortable: true },
              body: { kind: 'text', title: 'Note', required: true, searchable: true, filterable: true, sortable: true },
              userId: { kind: 'user', title: 'Owner', classification: 'internal' },
              createdAt: { kind: 'dateTime', title: 'Created', sortable: true },
            },
          },
        },
      }),
      entities: {
        note: {
          actions: { read: 'team', create: 'team', update: 'team', delete: 'team', export: 'team' },
          audit: 'all',
          ownerField: 'userId',
          columns: { userId: 'user_id', createdAt: 'created_at' },
          peek: { title: 'body', subtitle: 'createdAt' },
          views: [
            {
              id: 'default',
              title: 'My notes',
              columns: ['body', 'createdAt'],
              filters: ['body'],
              sort: { field: 'createdAt', dir: 'desc' },
            },
          ],
          handlers: { search: (query, params, ctx) => ctx.service.search(query.trim(), params) },
        },
      },
    },
  ],
  ui: { dir: extensionPath(import.meta.url, '../ui') },
  hooks: (hooks) => {
    hooks.on('user.created', async ({ userId }) => {
      await notify({
        user_id: userId,
        kind: 'ext:example:welcome',
        title: 'Welcome to Example notes',
        body: 'Your notes stay personal.',
        payload: {},
        dedupe_key: 'example-welcome',
      });
    });
  },
  onInstall: () => logger.info('[example] installed'),
  discriminators: {
    shareResources: ['ext:example:note'],
    fileLinkTargets: ['ext:example:note'],
    auditApps: ['example'],
    runKinds: ['ext:example:sync'],
  },
  catalogSources: [{ id: 'example', load: async () => ({ bases: [], truncated: false }) }],

  // A read tool and a governed write tool (see tool.ts: writes must declare `proxy: 'write'`).
  tools: [exampleNotesQueryTool, exampleNotesMutationTool],
  routes: [{ path: '/api/ext/example', app: exampleRoutes, guards: [requireFeature('example')] }],

  // Its own MCP consent group, so a token can be granted `mcp:example` alone.
  agentContext: {
    promptFragment: () =>
      'Example notes are personal. Use the note tools when the member asks to save or retrieve a note.',
    resources: [
      {
        name: 'vocabulary',
        title: 'Example vocabulary',
        description: 'Terms used by personal notes.',
        read: () => '# Notes\nA note is a private reminder owned by one member.',
      },
    ],
    prompts: [
      {
        name: 'recall',
        title: 'Recall notes',
        description: 'Find a personal note.',
        arguments: [{ name: 'topic', required: true }],
        render: (args) => `Find my notes about ${args.topic ?? '{{topic}}'}.`,
      },
    ],
  },
  mcpResources: [
    {
      toolIds: ['example_notes_query'],
      list: async (ctx) =>
        (
          await noteAction(ctx.userId, 'read', () =>
            getExtensionServices<ExampleServices>(ctx.db, 'example').notes.list(ctx.userId),
          )
        ).map((note) => ({
          uri: `greenhouse://ext/example/note/${note.id}`,
          name: `note-${note.id}`,
          title: note.body?.slice(0, 80) ?? String(note.id),
          mimeType: 'text/markdown',
        })),
      templates: async () => [
        { name: 'example-note', uriTemplate: 'greenhouse://ext/example/note/{id}', mimeType: 'text/markdown' },
      ],
      read: async (uri, ctx) => {
        const match = /^greenhouse:\/\/ext\/example\/note\/(\d+)$/.exec(uri);
        if (!match) return undefined;
        const note = await noteAction(ctx.userId, 'read', () =>
          getExtensionServices<ExampleServices>(ctx.db, 'example').notes.get(ctx.userId, Number(match[1])),
        );
        return note ? { uri, mimeType: 'text/markdown', text: note.body ?? '' } : undefined;
      },
    },
  ],
  toolResults: [
    {
      toolId: 'example_notes_query',
      summarizeOutput: (out) =>
        out.error ? { error: out.error } : { notes: Array.isArray(out.notes) ? out.notes.length : 0 },
    },
  ],
  settingValueValidators: [
    (key, value) =>
      key === 'example.greeting' && typeof value === 'string' && value.includes('\u0000')
        ? { ok: false, error: 'Greeting must not contain NUL' }
        : null,
  ],
  mcpGroups: ['example'],
  // Its records get deeplinks (`#/example/notes/42`) and peeks in chat.
  entityKinds: [{ kind: 'ext:example:note', route: '#/example/notes/:id' }],
  // …and a lane in the global search palette.
  // …and its own drive scope: a file cabinet per note, inside the shared
  // `drive_*` tables, keyed by `owner_key` and guarded by this resolver.
  driveScopes: [
    {
      scope: 'example-note',
      authorize: async (ownerKey, { userId, db }) => {
        if (!ownerKey) return null;
        const { notes } = getExtensionServices<ExampleServices>(db, 'example');
        // Notes are personal, so the cabinet is too: `get` is already scoped to
        // the caller, so a note that is not theirs simply is not found.
        const note = await notes.get(userId, Number(ownerKey));
        return note ? 'editor' : null;
      },
    },
  ],
  // …and a whole-dataset lane in `export_data`, so the model exports the notes
  // as a file instead of transcribing them into an inline payload.
  exportSources: [
    {
      type: 'example_notes',
      schema: z.object({ type: z.literal('example_notes') }),
      describe: 'export every note the signed-in user has saved in the Example extension.',
      load: async (_source, { userId }, db) => {
        const { notes } = getExtensionServices<ExampleServices>(db, 'example');
        const rows = await noteAction(userId, 'export', () => notes.list(userId, 1000));
        return {
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'body', label: 'Note' },
            { key: 'created_at', label: 'Created' },
          ],
          rows: rows as unknown as Array<Record<string, unknown>>,
          defaultFilename: 'example-notes',
          defaultSheetName: 'Notes',
        };
      },
    },
  ],
  featureFlags: [
    {
      key: 'example',
      label: 'Example notes',
      description: 'The reference extension: personal notes, its tool and its page',
      defaultEnabled: false,
    },
  ],
  workspaceSettings: [
    {
      key: 'example.greeting',
      group: 'example',
      label: 'Greeting',
      description: 'Shown at the top of the Example notes page.',
      type: 'string',
      placeholder: 'Welcome to your notes',
      maxLength: 120,
    },
  ],

  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createExampleServices,
  resetTables: ['ext_example_notes'],

  jobs: [
    {
      id: 'example-note-count',
      cron: '0 3 * * *',
      run: async () => {
        const { notes } = getExtensionServices<ExampleServices>(getDb(), 'example');
        logger.info(`[example] ${await notes.count()} note(s) in total`);
      },
    },
  ],
  commands: [
    {
      name: 'example:count',
      usage: 'Count the notes stored by the example extension',
      run: async () => {
        const { notes } = getExtensionServices<ExampleServices>(getDb(), 'example');
        console.log(await notes.count());
        return 0;
      },
    },
  ],

  onBoot: () => {
    logger.info('[example] extension ready');
  },
});

// Compatibility tools are alternate transports for the same generated application actions.
for (const app of definition.applications ?? []) {
  app.platformTools = {
    query: [...(app.platformTools?.query ?? []), 'example_notes_query'],
    command: [...(app.platformTools?.command ?? []), 'example_notes_mutation'],
  };
}
export const exampleExtension = definition;
export default exampleExtension;
