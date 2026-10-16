import { Hono } from 'hono';
import { registerAdapter } from '@greenhouse/providers';
import type { Services } from '../app.js';
import { requireAdmin } from '../auth/middleware.js';
import type { AppEnv } from '../http/env.js';
import type { GreenhouseExtension } from './define.js';

export function registerExtensionAdapters(extensions: readonly GreenhouseExtension[]) {
  for (const extension of extensions) for (const adapter of extension.providerAdapters ?? []) registerAdapter(adapter);
}

export function extensionTools(extensions: readonly GreenhouseExtension[], services: Services) {
  const tools = extensions.flatMap((extension) => {
    const tools = [...(extension.tools?.(services) ?? [])];
    if (
      tools.some(
        (tool) =>
          !tool.name.startsWith(`ext_${extension.id.replaceAll('-', '_')}_`) || !/^[a-z0-9_]{1,64}$/.test(tool.name),
      )
    )
      throw new Error(`Extension tool must be namespaced: ${extension.id}`);
    return tools;
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error('Duplicate extension tool');
  return tools;
}

export function extensionRoutes(extensions: readonly GreenhouseExtension[], services: Services) {
  const app = new Hono<AppEnv>();
  app.get('/extensions', (c) =>
    c.json({
      items: extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        pages: extension.pages ?? [],
        settings_sections: extension.settingsSections ?? [],
        admin_sections: c.get('member').role === 'admin' ? (extension.adminSections ?? []) : [],
        entity_panels: extension.entityPanels ?? [],
      })),
    }),
  );
  for (const extension of extensions) {
    const routes = new Hono<AppEnv>();
    routes.use('/admin/*', requireAdmin);
    routes.use('/admin', requireAdmin);
    if (extension.routes) routes.route('/', extension.routes(services));
    app.route(`/ext/${extension.id}`, routes);
  }
  return app;
}
