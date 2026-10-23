/**
 * web_search / read_url — the team's paid web services for members' agents
 * (MCP group `services`, v1.6).
 *
 * The in-app assistant has external_search (search + optional page extraction
 * in one call). An external agent gets the two halves as separate tools so it
 * pays for exactly what it asks for. Both run the same metered code as
 * external_search (external-search/index.ts): one `web_search` call per search
 * at the answering provider's price, one `page_read` call per page.
 *
 * read_url is SSRF-guarded twice: the URL must name a public host before
 * anything is reserved (assertSafePublicPageUrl), and the local fallback fetch
 * re-checks every hop and the resolved address at connect time
 * (fetchPublicPage). Lazy: built only on the external surfaces
 * (agent-runtime/service-tools.ts), so Chat keeps external_search alone.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { defineTool, type ToolMeta } from './define.js';
import { findBudgetRefusal } from '../usage/budget-errors.js';
import { assertSafePublicPageUrl } from '../security/network.js';
import { ContentExtractorChain } from './external-search/extractor.js';
import { buildProviderRegistry, readPageMetered, searchWeb } from './external-search/index.js';
import type { SearchProviderRegistry } from './external-search/providers/interface.js';
import { sanitizeContent, sanitizeSnippet } from './external-search/sanitizer.js';
import type { ContentExtractor } from './external-search/types.js';

const webSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('What to search for'),
  max_results: z.number().int().min(1).max(10).default(5).describe('How many results to return (1–10)'),
  language: z.enum(['en', 'zh', 'auto']).default('auto').describe('Preferred result language'),
});

const readUrlSchema = z.object({
  url: z.string().min(1).max(2048).describe('The http(s) address of a public web page'),
});

const webSearchMeta: ToolMeta = {
  id: 'web_search',
  name: 'Web Search',
  brief: 'Search the web (paid per search)',
  description:
    'Search the public web and get titles, links and snippets. Each search is paid by the team and counted ' +
    'against your member budget. To read a result in full, call read_url with its link.',
  category: 'team',
  is_global: true,
  icon: 'Globe',
  surface: { proxy: 'read', mcp: 'services', openWorld: true, externalOnly: true },
  sort_order: 13,
};

const readUrlMeta: ToolMeta = {
  id: 'read_url',
  name: 'Read Web Page',
  brief: 'Read a public web page as text (paid per page)',
  description:
    'Fetch a public web page and return its readable text (about 16,000 characters at most). Only public ' +
    'http(s) addresses: localhost, private networks and addresses with credentials are refused. Each page is ' +
    'paid by the team and counted against your member budget. A long reply comes back in pages; read on with ' +
    'tool_output_read only as far as you need.',
  category: 'team',
  is_global: true,
  icon: 'FileText',
  surface: { proxy: 'read', mcp: 'services', openWorld: true, externalOnly: true },
  sort_order: 14,
};

export interface WebServiceToolDeps {
  /** Test seam; production builds the providers from the environment. */
  registry?: SearchProviderRegistry;
  /** Test seam; production uses Jina Reader, then this server's guarded fetch. */
  extractor?: ContentExtractor & { names: string[] };
}

export function createWebSearchTool(deps: WebServiceToolDeps = {}) {
  return tool({
    description: webSearchMeta.description,
    inputSchema: webSearchSchema,
    execute: async (input: z.infer<typeof webSearchSchema>) => {
      let found;
      try {
        found = await searchWeb(
          deps.registry ?? buildProviderRegistry(),
          { query: input.query, maxResults: input.max_results, language: input.language, extractContent: false },
          'web_search',
        );
      } catch (error) {
        // Over budget is the agent's to know, in its own words (a tool error).
        if (findBudgetRefusal(error)) throw error;
        return { error: `Web search failed: ${toErrorMessage(error)}` };
      }
      const { results, provider } = found;
      return {
        query: input.query,
        provider,
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: sanitizeSnippet(result.snippet),
        })),
      };
    },
  });
}

export function createReadUrlTool(deps: WebServiceToolDeps = {}) {
  return tool({
    description: readUrlMeta.description,
    inputSchema: readUrlSchema,
    execute: async (input: z.infer<typeof readUrlSchema>) => {
      let url: string;
      try {
        // Refused before anything is reserved or fetched.
        url = assertSafePublicPageUrl(input.url.trim()).toString();
      } catch (error) {
        return { error: `${(error as Error).message}. read_url only reads public http(s) pages.` };
      }
      let page;
      try {
        page = await readPageMetered(deps.extractor ?? new ContentExtractorChain(), url, 'read_url');
      } catch (error) {
        if (findBudgetRefusal(error)) throw error;
        return { error: `Could not read ${url}: ${toErrorMessage(error)}` };
      }
      return {
        url,
        title: page.title,
        content: sanitizeContent(page.content, url).text,
        truncated: page.truncated,
      };
    },
  });
}

export const webSearchTool = defineTool({ meta: webSearchMeta, kind: 'lazy' });
export const readUrlTool = defineTool({ meta: readUrlMeta, kind: 'lazy' });
