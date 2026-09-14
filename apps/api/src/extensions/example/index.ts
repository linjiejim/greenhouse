/**
 * The example extension — a complete, minimal reference for every field of the
 * contract: a table with its own migration, a service, a lazy tool, routes with a
 * feature guard, a feature flag + point, a runtime setting, a job and a command.
 *
 * It is compiled into every build but off by default; enable it per deployment
 * with `extensions.enabled: ['example']` in greenhouse.config.ts or
 * `GREENHOUSE_EXTENSIONS=example`. Copy this folder to start your own.
 */
import { logger } from '@greenhouse/utils/logger';
import { getDb, getExtensionServices } from '@greenhouse/db';
import { requireFeature } from '../../auth/middleware.js';
import { defineExtension, extensionPath } from '../define.js';
import { exampleRoutes } from './routes.js';
import { createExampleServices, type ExampleServices } from './service.js';
import { exampleNotesQueryTool } from './tool.js';

export const exampleExtension = defineExtension({
  id: 'example',
  name: 'Example notes',
  description: 'Reference extension: per-user notes with a tool, routes, a flag, a setting and a job.',

  tools: [exampleNotesQueryTool],
  routes: [{ path: '/api/ext/example', app: exampleRoutes, guards: [requireFeature('example')] }],

  featureFlags: [
    {
      key: 'example',
      label: 'Example notes',
      description: 'The reference extension: personal notes, its tool and its page',
      defaultEnabled: false,
    },
  ],
  featurePoints: [
    {
      key: 'example',
      title: 'Example notes',
      description: 'Personal notes from the reference extension (page, REST and chat tool).',
      icon: 'StickyNote',
      kind: 'flag',
      group: 'advanced',
      flag: 'example',
      toolIds: ['example_notes_query'],
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

  migrations: { dir: extensionPath(import.meta.url, 'migrations') },
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
