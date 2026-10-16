import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuerySchema, idParamSchema } from '@greenhouse/contract';
import { exampleSettingsSchema, noteInputSchema } from '@greenhouse/contract/extensions/example';
import type { ProviderAdapter } from '@greenhouse/providers';
import { defineExtension, defineTool, readJson, readQuery, readParam, type AppEnv } from '../../extension-kit.js';
import { exampleService } from './service.js';

const adapter: ProviderAdapter<'search', { baseUrl: string }> = {
  capability: 'search',
  kind: 'example-search',
  label: 'Example search',
  configSchema: z.object({ baseUrl: z.string().url() }),
  secretKeys: [],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, fetch }) => ({
    async search(query, options) {
      const url = new URL(config.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(options?.limit ?? 5));
      const response = await fetch(url);
      if (!response.ok) throw new Error('Example search is unavailable');
      return z
        .array(z.object({ title: z.string(), url: z.string().url(), snippet: z.string() }))
        .max(20)
        .parse(await response.json());
    },
  }),
};

export const exampleExtension = defineExtension({
  id: 'example',
  name: 'Example',
  pages: ['notes'],
  settingsSections: ['preferences'],
  adminSections: ['preferences'],
  entityPanels: [
    { id: 'notes', entity: 'doc' },
    { id: 'note', entity: 'ext:example:note' },
  ],
  migrations: { dir: fileURLToPath(new URL('./migrations', import.meta.url)) },
  providerAdapters: [adapter],
  routes: (services) =>
    new Hono<AppEnv>()
      .get('/notes', async (c) =>
        c.json(
          await exampleService.list(
            c.get('member').id,
            readQuery(c, pageQuerySchema.extend({ q: z.string().trim().max(100).optional() })),
          ),
        ),
      )
      .post('/notes', async (c) =>
        c.json(await exampleService.create(c.get('member').id, await readJson(c, noteInputSchema)), 201),
      )
      .get('/notes/:id', async (c) =>
        c.json(await exampleService.get(c.get('member').id, readParam(c, 'id', idParamSchema))),
      )
      .get('/settings', async (c) => c.json(await exampleService.settings(c.get('member').id, false)))
      .patch('/settings', async (c) =>
        c.json(
          await exampleService.saveSettings(
            c.get('member').id,
            false,
            (await readJson(c, exampleSettingsSchema)).label,
          ),
        ),
      )
      .get('/admin/settings', async (c) => c.json(await exampleService.settings(c.get('member').id, true)))
      .patch('/admin/settings', async (c) =>
        c.json(
          await exampleService.saveSettings(c.get('member').id, true, (await readJson(c, exampleSettingsSchema)).label),
        ),
      )
      .get('/docs/:id/panel', async (c) => {
        await services.knowledge.getDoc(c.get('member').id, readParam(c, 'id', idParamSchema));
        return c.json(await exampleService.list(c.get('member').id, { limit: 5 }));
      }),
  tools: () => [
    defineTool({
      name: 'ext_example_notes',
      description: 'Read your example notes, or save a note after approval.',
      input: z.object({
        action: z.enum(['list', 'create']),
        title: z.string().max(120).optional(),
        body: z.string().max(4000).optional(),
      }),
      risk: 'read',
      private: true,
      taints: true,
      callRisk: async (input) => (input.action === 'list' ? 'read' : 'tier2'),
      describe: (_input, ctx) => ({
        summary: ctx.locale === 'zh' ? '保存示例笔记' : 'Save an example note',
        details: [],
      }),
      execute: async (input, ctx) =>
        input.action === 'list'
          ? exampleService.list(ctx.memberId, { limit: 20 })
          : exampleService.create(ctx.memberId, noteInputSchema.parse(input)),
    }),
  ],
  searchSources: () => [
    {
      id: 'notes',
      async search(memberId, query, limit) {
        const found = await exampleService.list(memberId, { q: query, limit });
        return found.items.map((note) => ({
          id: note.id,
          title: note.title,
          snippet: note.body.slice(0, 120),
          path: `notes/${encodeURIComponent(note.id)}`,
        }));
      },
    },
  ],
});
