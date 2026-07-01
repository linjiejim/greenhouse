/**
 * External Search tool — search the web and optionally extract page content.
 *
 * Provides the agent with access to external information sources beyond the
 * internal wiki knowledge base. Designed with defense-in-depth:
 *
 * 1. Pluggable search providers (Tavily primary, Brave fallback)
 * 2. Content extraction via Jina Reader (headless browser, anti-scrape)
 * 3. Content sanitization with prompt injection detection
 * 4. XML envelope isolation for all external content
 * 5. Bounded concurrency for parallel content extraction
 *
 * Env vars:
 *   TAVILY_API_KEY       — Tavily search (primary, recommended)
 *   BRAVE_SEARCH_API_KEY — Brave Search (fallback)
 */

import { tool } from 'ai';
import { defineTool, type ToolMeta } from '../define.js';
import { z } from 'zod';
import { SearchProviderRegistry } from './providers/interface.js';
import { createTavilyProvider } from './providers/tavily.js';
import { createBraveProvider } from './providers/brave.js';
import { createFirecrawlProvider } from './providers/firecrawl.js';
import { ContentExtractorChain } from './extractor.js';
import { sanitizeContent, sanitizeSnippet } from './sanitizer.js';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import type { ExternalSearchOutput } from './types.js';

// ─── Constants ───────────────────────────────────────────

/** Max concurrent content extraction requests */
const EXTRACT_CONCURRENCY = 3;

// ─── Zod Schema ──────────────────────────────────────────

const externalSearchInputSchema = z.object({
  query: z.string().min(1).max(500).describe('Search query (web search keywords)'),
  maxResults: z.number().min(1).max(10).default(5).describe('Maximum number of search results to return'),
  extractContent: z
    .boolean()
    .default(false)
    .describe('Extract full page content for each result (slower, more tokens). Use when snippets are not enough.'),
  language: z.enum(['en', 'zh', 'auto']).default('auto').describe('Search language preference'),
});

// ─── Provider Setup ──────────────────────────────────────

/**
 * Build the search provider registry from environment variables.
 * Providers are registered in priority order.
 */
export function buildProviderRegistry(): SearchProviderRegistry {
  const registry = new SearchProviderRegistry();

  // Priority 1: Tavily (AI-optimized, returns clean content)
  const tavily = createTavilyProvider();
  if (tavily) registry.register(tavily);

  // Priority 2: Firecrawl (search + scrape in one call, returns markdown)
  const firecrawl = createFirecrawlProvider();
  if (firecrawl) registry.register(firecrawl);

  // Priority 3: Brave Search (good free tier)
  const brave = createBraveProvider();
  if (brave) registry.register(brave);

  return registry;
}

// ─── Tool Factory ────────────────────────────────────────

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'external_search',
  name: 'Web Search',
  brief: 'Search the internet for latest information',
  description: `Search external information on the internet, with multi-round search and web content extraction.
Research principles: faithful to facts, multi-source verification, distinguish inference from fact.
Research flow: broad search (3-5 queries) → targeted deep-dive (extractContent) → gap filling → cross-verification.
Information reliability tiers: L1 official primary sources > L2 commercial data > L3 industry platforms > L4 media > L5 general search.
Search in both Chinese and English. Key information requires confirmation from at least two independent sources.`,
  category: 'team',
  is_global: true,
  icon: 'Globe',
  group: 'web',
  surface: { proxy: 'read' },
};

export function createExternalSearchTool() {
  const registry = buildProviderRegistry();
  const extractor = new ContentExtractorChain();

  return tool({
    description: meta.description,
    inputSchema: externalSearchInputSchema,
    execute: async (input): Promise<ExternalSearchOutput> => {
      const { query, maxResults, extractContent, language } = input;

      // 1. Search via provider registry (auto-fallback)
      const { results: rawResults, provider } = await registry.search(query, {
        maxResults,
        language,
        extractContent,
      });

      // 2. Build output with sanitized snippets
      const outputResults: ExternalSearchOutput['results'] = rawResults.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: sanitizeSnippet(r.snippet),
        // Tavily returns content inline — sanitize it
        content: r.content ? sanitizeContent(r.content, r.url).text : undefined,
      }));

      // 3. If extractContent requested and results don't already have content,
      //    fetch page content in parallel with bounded concurrency
      if (extractContent) {
        const needsExtraction = outputResults.filter((r) => !r.content);

        if (needsExtraction.length > 0) {
          await runWithConcurrency(needsExtraction, EXTRACT_CONCURRENCY, async (result) => {
            try {
              const extracted = await extractor.extract(result.url);
              const sanitized = sanitizeContent(extracted.content, result.url);
              result.content = sanitized.text;
            } catch {
              // Extraction failure is non-fatal — keep the snippet
              result.content = undefined;
            }
          });
        }
      }

      return {
        query,
        resultCount: outputResults.length,
        provider,
        results: outputResults,
      };
    },
  });
}

export const externalSearchTool = defineTool({ meta, kind: 'static', create: () => createExternalSearchTool() });
