/**
 * Firecrawl Search Provider — search + scrape engine.
 *
 * Combines web search with Firecrawl's scraping capabilities to return
 * full page content (markdown) for search results. This makes it
 * particularly powerful: search results come with pre-extracted content,
 * eliminating the need for a separate content extraction step.
 *
 * API docs: https://docs.firecrawl.dev/api-reference/endpoint/search
 *
 * Env: FIRECRAWL_API_KEY
 */

import type { SearchProvider, SearchResult, SearchOpts } from './interface.js';

const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v2/search';
const REQUEST_TIMEOUT_MS = 30_000; // Firecrawl may take longer due to scraping

interface FirecrawlWebResult {
  title?: string;
  description?: string;
  url: string;
  markdown?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
    error?: string;
  };
}

interface FirecrawlResponse {
  success: boolean;
  data?: {
    web?: FirecrawlWebResult[];
  };
  warning?: string;
}

export class FirecrawlProvider implements SearchProvider {
  readonly name = 'firecrawl';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body: Record<string, unknown> = {
        query,
        limit: opts.maxResults,
        timeout: REQUEST_TIMEOUT_MS,
      };

      // Only request markdown scraping when full content is needed (3 credits)
      // Default search-only mode costs 1 credit
      if (opts.extractContent) {
        body.scrapeOptions = {
          formats: ['markdown'],
        };
      }

      // Set country for language targeting
      if (opts.language === 'zh') {
        body.country = 'CN';
      } else if (opts.language === 'en') {
        body.country = 'US';
      }

      const response = await fetch(FIRECRAWL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Firecrawl API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as FirecrawlResponse;

      if (!data.success) {
        throw new Error(`Firecrawl search failed: ${data.warning || 'unknown error'}`);
      }

      const webResults = data.data?.web || [];

      return webResults.map((r) => ({
        title: r.title || r.metadata?.title || '(no title)',
        url: r.url,
        snippet: (r.description || r.metadata?.description || '').slice(0, 500),
        // Firecrawl returns full markdown content when scrapeOptions is set
        content: r.markdown || undefined,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a Firecrawl provider if the API key is available.
 */
export function createFirecrawlProvider(): FirecrawlProvider | null {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  return new FirecrawlProvider(apiKey);
}
