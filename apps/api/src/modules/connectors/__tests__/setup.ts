/** A test app whose connectors may reach the local fake servers: development rules, a catalog of our own. */

import type { ServiceOptions } from '../../../app.js';
import { createTestApp } from '../../../testing.js';
import type { CatalogItem } from '../catalog.js';

/** A catalog entry for a server that only exists in the test. */
export function catalogEntry(url: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'test.example/desk',
    slug: 'desk',
    title: 'Order desk',
    title_zh: '订单台',
    description: 'Orders and support tickets.',
    description_zh: '订单与工单。',
    category: 'productivity',
    website_url: null,
    icon_url: null,
    url,
    transport: 'streamable_http',
    auth: {
      mode: 'none',
      header: null,
      query_param: null,
      prefix: null,
      help: null,
      help_zh: null,
      help_url: null,
      scope: null,
      zero_config: true,
    },
    read_only_tools: [],
    verification: { level: 'call', date: '2026-10-13', notes: null },
    ...over,
  };
}

export async function connectorApp(options: ServiceOptions = {}) {
  // Plain http to this machine is allowed in development only: the fake servers listen on 127.0.0.1.
  const app = createTestApp({ NODE_ENV: 'development' }, options);
  const admin = await app.member('admin');
  const lin = await app.member();
  const chen = await app.member();
  const install = (body: Record<string, unknown>) =>
    app.call('POST', '/api/admin/connectors', { token: admin.token, body });
  return { ...app, admin, lin, chen, install };
}
